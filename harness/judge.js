const path = require('path');
const fs = require('fs');
const aiSdkPath = '/usr/lib/node_modules/ai'; // Use global or standard path
const googleSdkPath = '/usr/lib/node_modules/@ai-sdk/google';
const { generateText } = require(aiSdkPath);
const { google } = require(googleSdkPath);

async function judge(tracePath, promptTemplatePath) {
  try {
    const trace = fs.readFileSync(tracePath, 'utf8');
    const template = fs.readFileSync(promptTemplatePath, 'utf8');
    
    const prompt = template.replace('{{trace}}', trace);

    const { text } = await generateText({
      model: google('gemini-1.5-flash'),
      prompt: prompt,
    });
    
    // Attempt to parse JSON from the response
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/) || text.match(/{[\s\S]*?}/);
    let result;
    if (jsonMatch) {
      try {
        result = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      } catch (e) {
        result = { error: 'JSON parse error', raw: text };
      }
    } else {
      result = { error: 'No JSON found in response', raw: text };
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node judge.js <trace_path> <template_path>');
  process.exit(1);
}

judge(args[0], args[1]).then(result => {
  console.log(JSON.stringify(result, null, 2));
});
