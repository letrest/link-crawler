import { NextRequest, NextResponse } from 'next/server';
import * as cheerio from 'cheerio';

interface LinkWithOrigin {
  url: string;
  originPage: string;
  selector?: string;
  text?: string;
}

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
    const links: LinkWithOrigin[] = [];
    const seenLinks = new Set<string>();

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;

      try {
        const linkUrl = new URL(href, url);

        // Only include links from the same domain
        if (linkUrl.hostname === parsedUrl.hostname) {
          // Filter out non-HTML resources (images, PDFs, etc.)
          if (!isHtmlDocument(linkUrl.pathname)) {
            return;
          }

          const linkHref = linkUrl.href;
          if (!seenLinks.has(linkHref)) {
            seenLinks.add(linkHref);
            
            // Generate a CSS selector for this element
            const selector = generateSelector($, element);
            const text = $(element).text().trim().substring(0, 100); // Limit text length
            
            links.push({
              url: linkHref,
              originPage: url,
              selector,
              text: text || undefined,
            });
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

// Check if URL points to an HTML document (not images, PDFs, etc.)
function isHtmlDocument(pathname: string): boolean {
  // List of file extensions to exclude
  const nonHtmlExtensions = [
    // Images
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff',
    // Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf',
    // Archives
    '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
    // Media
    '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv', '.wav', '.aac', '.flac',
    // Other
    '.exe', '.dll', '.app', '.dmg', '.iso', '.torrent', '.apk',
  ];

  const lowerPathname = pathname.toLowerCase();
  return !nonHtmlExtensions.some(ext => lowerPathname.endsWith(ext));
}

// Generate a CSS selector for an element
function generateSelector($: cheerio.CheerioAPI, element: any): string {
  const selectors: string[] = [];
  let current: any | null = element;

  while (current && current.type === 'tag') {
    let selector = current.name;
    
    // Add id if present
    if (current.attribs.id) {
      selector += `#${current.attribs.id}`;
      selectors.unshift(selector);
      break; // ID is unique, no need to go further
    }
    
    // Add classes if present
    if (current.attribs.class) {
      const classes = current.attribs.class.split(/\s+/).filter(Boolean);
      if (classes.length > 0) {
        selector += '.' + classes.join('.');
      }
    }
    
    // Add nth-child if needed to make it unique
    const siblings = $(current).siblings(current.name);
    if (siblings.length > 0) {
      const index = $(current).parent().children(current.name).index(current) + 1;
      selector += `:nth-child(${index})`;
    }
    
    selectors.unshift(selector);
    current = current.parent;
    
    // Limit depth to avoid overly complex selectors
    if (selectors.length >= 5) break;
  }
  
  return selectors.join(' > ');
}
