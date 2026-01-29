import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { url, captureBody } = await request.json();

    if (!url) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    try {
      const methodToUse = captureBody ? 'GET' : 'HEAD';
      const response = await fetch(url, {
        method: methodToUse,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'accept-encoding': 'gzip, deflate, br, zstd',
          'accept-language': 'en-NL,en-GB;q=0.9,en-US;q=0.8,en;q=0.7'
        },
      }).catch(async () => {
        // If the initial request fails, try GET
        return fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      let body: string | undefined;
      if (captureBody) {
        try {
          body = await response.text();
        } catch (err) {
          console.error('Failed to capture response body:', err);
        }
      }

      return NextResponse.json({
        url,
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
      });
    } catch (error) {
      return NextResponse.json({
        url,
        status: 0,
        statusText: 'Request Failed',
        headers: {},
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  } catch (error) {
    console.error('Error in fetch-headers endpoint:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
