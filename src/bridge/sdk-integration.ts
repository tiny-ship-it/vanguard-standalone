import { google } from '@ai-sdk/google';
import { streamText } from 'ai';

/**
 * Example of using Vercel AI SDK v4 patterns alongside the bridge.
 * This can be used for metadata generation or side-channel text processing.
 */
export async function generateStream(prompt: string) {
  return streamText({
    model: google('gemini-2.0-flash-exp'),
    prompt: prompt,
  });
}
