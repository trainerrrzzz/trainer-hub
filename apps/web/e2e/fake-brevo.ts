import { createServer } from 'node:http';
import type { ReceivedEmail } from './brevo';

// The fake Brevo server (F001), a Playwright web server (playwright.config.ts). The app posts its
// emails here like it would to Brevo's `POST /v3/smtp/email`; the specs read them back with
// `GET /emails?to=<address>` (e2e/brevo.ts). Emails are kept in memory until the server stops,
// so every spec uses an address of its own.

const port = Number(process.env.PORT);
if (!port) throw new Error('Set PORT to the port of the fake Brevo server.');

const received: ReceivedEmail[] = [];

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  if (request.method === 'POST' && url.pathname === '/v3/smtp/email') {
    const body = JSON.parse(await readBody(request)) as {
      to: { email: string }[];
      subject: string;
      textContent: string;
      htmlContent: string;
    };
    received.push({
      to: body.to[0]?.email ?? '',
      subject: body.subject,
      text: body.textContent,
      html: body.htmlContent,
    });
    return json(201, { messageId: `<fake-${received.length}@brevo.e2e.test>` });
  }
  if (request.method === 'GET' && url.pathname === '/emails') {
    const to = url.searchParams.get('to')?.toLowerCase();
    return json(
      200,
      received.filter((email) => !to || email.to.toLowerCase() === to),
    );
  }
  // Playwright waits for this to answer before it starts the specs.
  if (request.method === 'GET' && url.pathname === '/') return json(200, { status: 'ok' });
  return json(404, { message: 'not found' });
}).listen(port, 'localhost');

async function readBody(request: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
