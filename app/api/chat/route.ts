// TODO: Implement the chat API with Groq and web scraping with Cheerio and Puppeteer
// Refer to the Next.js Docs on how to read the Request body: https://nextjs.org/docs/app/building-your-application/routing/route-handlers
// Refer to the Groq SDK here on how to use an LLM: https://www.npmjs.com/package/groq-sdk
// Refer to the Cheerio docs here on how to parse HTML: https://cheerio.js.org/docs/basics/loading
// Refer to Puppeteer docs here: https://pptr.dev/guides/what-is-puppeteer
import { NextResponse } from "next/server";
import { getGroqResponse } from "@/utils/groqClient";
import { scrapeUrl, urlPattern } from "@/utils/scraper";

export async function POST(req: Request) {
  try {
    const { message, messages } = await req.json();

    console.log("Message received:", message);
    console.log("Messages:", messages);

    const url = message.match(urlPattern);

    let scrappedContent = "";

    if (url) {
      console.log("URL found:", url);
      const scraperResponse = await scrapeUrl(url[0]);
      console.log("Scraper response:", scraperResponse);
      console.log("Scrapped content:", scrappedContent);
      if (scraperResponse) scrappedContent = scraperResponse.content;
    }

    const userQuery = message.replace(url ? url[0] : "", "").trim();

    const userPrompt = `
    Answer my question: ${userQuery}
    Based on the following content:
    
    <content>
      ${scrappedContent}
    </content>
    `;

    console.log("User prompt:", userPrompt);

    const llmMessage = [
      ...messages,
      {
        role: "user",
        content: userPrompt,
      },
    ];

    const response = await getGroqResponse(llmMessage);

    return NextResponse.json({ message: response });
  } catch (error) {
    return NextResponse.json({ message: `Error: ${error}` });
  }
}
