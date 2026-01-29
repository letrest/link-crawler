import { NextRequest, NextResponse } from 'next/server';
import * as cheerio from 'cheerio';

export async function POST(request: NextRequest) {
  try {
    console.log('Received crawl request');
    const { url } = await request.json();

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    // Parse and validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json({ error: 'Invalid URL format' }, { status: 400 });
    }

    // Fetch the page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch URL: ${response.statusText}` },
        { status: response.status }
      );
    }

    const html = await response.text();
    console.log('Fetched HTML length:', html.length);

    // Parse HTML and extract links
    const $ = cheerio.load(html);
    const links: string[] = [];
    const seenLinks = new Set<string>();

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;

      try {
        const linkUrl = new URL(href, url);

        // Only include links from the same domain
        if (linkUrl.hostname === parsedUrl.hostname) {
          const linkHref = linkUrl.href;
          if (!seenLinks.has(linkHref)) {
            seenLinks.add(linkHref);
            links.push(linkHref);
          }
        }
      } catch {
        // Invalid URLs are skipped
      }
    });

    return NextResponse.json({ links, totalLinks: links.length });
  } catch (error) {
    console.error('Error in crawl endpoint:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
