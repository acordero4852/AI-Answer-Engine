import axios from "axios";
import * as cheerio from "cheerio";
import { Logger } from "./logger";
import { Redis } from "@upstash/redis";
import { ChatMessage } from "./groqClient";

const logger = new Logger("scraper");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CACHE_TTL = 7 * 60 * 60 * 24; // 7 days
const MAX_CACHE_SIZE = 1024000; // 1MB

export const urlPattern =
  /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi;

function cleanText(text: string) {
  return text.replace(/\s+/g, " ").replace(/\n/g, " ").trim();
}

export async function scrapeUrl(url: string) {
  try {
    logger.info(`Starting scrape process for: ${url}`);

    const cached = await getCachedContent(url);

    if (cached) {
      logger.info(`Using cached content for: ${url}`);
      return cached;
    }

    logger.info(`Cache miss - proceeding with fresh scrape for: ${url}`);

    const response = await axios.get(url);
    const $ = cheerio.load(response.data);
    $("script").remove();
    $("style").remove();
    $("noscript").remove();
    $("iframe").remove();

    const title = $("title").text();
    const metaDescription = $('meta[name="description"]').attr("content") || "";
    const h1 = $("h1")
      .map((_, el) => $(el).text())
      .get()
      .join(" ");
    const h2 = $("h2")
      .map((_, el) => $(el).text())
      .get()
      .join(" ");

    const articleText = $("article")
      .map((_, el) => $(el).text())
      .get()
      .join(" ");
    const mainText = $("main")
      .map((_, el) => $(el).text())
      .get()
      .join(" ");
    const contentText = $('.content, #content, [class*="content"]')
      .map((_, el) => $(el).text())
      .get()
      .join(" ");

    const paragraphs = $("p")
      .map((_, el) => $(el).text())
      .get()
      .join(" ");

    const listItems = $("li")
      .map((_, el) => $(el).text())
      .get()
      .join(" ");

    let combinedContent = [
      title,
      metaDescription,
      h1,
      h2,
      articleText,
      mainText,
      contentText,
      paragraphs,
      listItems,
    ].join(" ");

    combinedContent = cleanText(combinedContent).slice(0, 40000);

    const finalResponse = {
      url,
      title: cleanText(title),
      heading: {
        h1: cleanText(h1),
        h2: cleanText(h2),
      },
      metaDescription: cleanText(metaDescription),
      content: combinedContent,
      error: null,
    };

    await cacheContent(url, finalResponse);
    return finalResponse;
  } catch (error) {
    console.error("Error scraping URL:", error);
    return {
      url,
      title: "",
      heading: {
        h1: "",
        h2: "",
      },
      metaDescription: "",
      content: "",
      error: "Failed to scrape the URL",
    };
  }
}

export interface ScrapedContent {
  url: string;
  title: string;
  heading: {
    h1: string;
    h2: string;
  };
  metaDescription: string;
  content: string;
  error: string | null;
  cachedAt?: number;
}

function isValidScrapedContent(data: any): data is ScrapedContent {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof data.url === "string" &&
    typeof data.title === "string" &&
    typeof data.heading.h1 === "string" &&
    typeof data.heading.h2 === "string" &&
    typeof data.metaDescription === "string" &&
    typeof data.content === "string" &&
    (data.error === null || typeof data.error === "string")
  );
}

function getCacheKey(url: string): string {
  const santitzedUrl = url.substring(0, 200);
  return `scrape:${santitzedUrl}`;
}

async function getCachedContent(url: string): Promise<ScrapedContent | null> {
  try {
    const cacheKey = getCacheKey(url);
    logger.info(`Getting cached content for key: ${cacheKey}`);
    const cached = await redis.get(cacheKey);

    if (!cached) {
      logger.info(`Cache miss - No cache content found for : ${url}`);
      return null;
    }

    logger.info(`Cache hit - Found cached content for : ${url}`);

    let parsed: any;
    if (typeof cached === "string") {
      try {
        parsed = JSON.parse(cached);
      } catch (parseError) {
        logger.error(`JSON parsing error for cache content: ${parseError}`);
        return null;
      }
    } else {
      parsed = cached;
    }

    if (isValidScrapedContent(parsed)) {
      const age = Date.now() - (parsed.cachedAt || 0);
      logger.info(`Cache content age: ${age}`);
      return parsed;
    }

    logger.warn(`Invalid cache content found for URL: ${cacheKey}`);
    await redis.del(cacheKey);
    return null;
  } catch (error) {
    logger.error(`Cache retrieval error: ${error}`);
    return null;
  }
}

async function cacheContent(
  url: string,
  content: ScrapedContent
): Promise<void> {
  try {
    const cacheKey = getCacheKey(url);
    content.cachedAt = Date.now();

    if (!isValidScrapedContent(content)) {
      logger.error(`Attempted to cache invalid content from for URL: ${url}`);
      return;
    }

    const serialized = JSON.stringify(content);

    if (serialized.length > MAX_CACHE_SIZE) {
      logger.warn(
        `Cache content size exceeds limit for URL: ${url} (${serialized.length} bytes)`
      );
      return;
    }

    await redis.set(cacheKey, serialized, { ex: CACHE_TTL });
    logger.info(
      `Successfully cached content for URL: ${url} (${serialized.length} bytes, TTL: ${CACHE_TTL})`
    );
  } catch (error) {
    logger.error(`Cache write error: ${error}`);
  }
}

export async function saveConversations(id: string, messages: ChatMessage[]) {
  try {
    logger.info(`Saving conversation with ID: ${id}`);
    await redis.set(`conversation:${id}`, JSON.stringify(messages));

    await redis.expire(`conversation:${id}`, 60 * 60 * 24 * 7);
    logger.info(
      `Successfully saved conversation ${id} with ${messages.length} messages`
    );
  } catch (error) {
    logger.error(`Failed to save conversation ${id}: ${error}`);
    throw error;
  }
}

export async function getConversation(id: string, message: ChatMessage[]) {
  try {
    logger.info(`Fetching conversation with ID: ${id}`);
    const data = await redis.get(`conversation:${id}`);

    if (!data) {
      logger.info(`No conversation found for ID: ${id}`);
      return message;
    }

    if (typeof data === "string") {
      const messages = JSON.parse(data);
      logger.info(
        `Successfully fetched conversation ${id} with ${messages.length} messages`
      );
      return messages;
    }

    logger.warn(`Successfully fetched conversation ${id}`);
    return data as ChatMessage[];
  } catch (error) {
    logger.error(`Failed to fetch conversation ${id}: ${error}`);
    throw error;
  }
}
