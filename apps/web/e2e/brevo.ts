import { expect } from '@playwright/test';
import { brevoServer } from './servers';

/** An email the app handed to the fake Brevo server (e2e/fake-brevo.ts). */
export interface ReceivedEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** The emails the fake Brevo server received for `address`, oldest first. */
export async function emailsTo(address: string): Promise<ReceivedEmail[]> {
  const response = await fetch(`${brevoServer.baseURL}/emails?to=${encodeURIComponent(address)}`);
  return (await response.json()) as ReceivedEmail[];
}

/** Waits until `count` emails to `address` have arrived, then returns them. */
export async function waitForEmails(address: string, count = 1): Promise<ReceivedEmail[]> {
  await expect.poll(async () => (await emailsTo(address)).length).toBeGreaterThanOrEqual(count);
  return await emailsTo(address);
}

/** Waits for the first email to `address`. */
export async function waitForEmail(address: string): Promise<ReceivedEmail> {
  const [email] = await waitForEmails(address);
  if (!email) throw new Error('No email arrived.');
  return email;
}

/** The 6-digit code of a sign-in email (EM-08): the line that holds nothing else. */
export function signInCode(email: ReceivedEmail): string {
  const code = /^\s*(\d{6})\s*$/m.exec(email.text)?.[1];
  if (!code) throw new Error('The email has no sign-in code.');
  return code;
}

/** The sign-in link of a sign-in email (EM-08): the confirm step of the sign-in page, with its token. */
export function signInLink(email: ReceivedEmail): string {
  const link = /\shref="([^"]*\/login\/confirm\?token=[^"]+)"/.exec(email.html)?.[1];
  if (!link) throw new Error('The email has no sign-in link.');
  return link.replaceAll('&amp;', '&');
}
