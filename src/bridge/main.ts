import { 
  JobContext, 
  WorkerOptions, 
  cli, 
  defineAgent, 
  multimodal 
} from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import 'dotenv/config';
import { FigmaProxy } from './figma-proxy.js';

/**
 * Project First Tiny: The Bridge
 * Multi-modal connection logic for Gemini Live API via LiveKit.
 */

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();

    console.log('Starting Bridge for room:', ctx.room.name);

    // Initialize Figma Proxy (expects FIGMA_TOKEN and FIGMA_FILE_KEY in env)
    const figmaProxy = new FigmaProxy(
      process.env.FIGMA_TOKEN || '',
      process.env.FIGMA_FILE_KEY || ''
    );

    // Initialize Gemini Multimodal Live agent
    const agent = new multimodal.MultimodalAgent({
      model: google.withModel('gemini-2.0-flash-exp'),
      description: 'A helpful real-time multimodal assistant with Figma awareness.',
    });

    // Start the agent in the room
    const session = await agent.start(ctx.room);

    // Context Injection: Fetch initial Figma state
    try {
      const snapshot = await figmaProxy.getSemanticSnapshot();
      console.log('Figma Semantic Snapshot initialized:', snapshot.rawSummary);
      // In a real scenario, we'd inject this into the session context
    } catch (e) {
      console.warn('Figma Proxy failed to initialize snapshot. Continuing without it.');
    }

    session.on('user_speech_started', () => {
      console.log('User started speaking...');
    });

    session.on('agent_speech_started', () => {
      console.log('Agent started speaking...');
    });
  },
});

// If running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  cli.runApp(new WorkerOptions({
    agentName: 'first-tiny-bridge',
  }));
}
