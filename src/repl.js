import dotenv from 'dotenv';
import readline from 'readline';
import chalk from 'chalk';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { unlinkSync } from 'fs';
import cliSpinners from 'cli-spinners';
import { fileURLToPath } from 'url';
import path from 'path';
import { parseZshHistory } from './tools/history.js';
import { getFileChangeSummary } from './dirUtils.js';
import Listener from './listener.js';
import speak from './speaker.js';
import minimist from 'minimist';
import Dialog2 from './dialog2.js';

const __filename = fileURLToPath(import.meta.url);
const ucDir = path.resolve(path.dirname(__filename), '..');
const dotenvFile = path.resolve(path.dirname(__filename), '../.env');

marked.use(
    markedTerminal({
        width: process.stdout.columns - 1,
        reflowText: true,
        tab: 2,
    }),
);

const chalk1 = chalk.cyan.bold;
const chalk2 = chalk.hex('#fcad01').bold;
const chalk3 = chalk.gray.bold;

dotenv.config({ path: dotenvFile });
let dialog;
let rl;
let lastInput = +new Date();
let listener = null;
let working = false;
let shouldSpeak = false;
let shouldUpdate = false;

async function main() {
    const args = minimist(process.argv.slice(2), {
        boolean: ['listen', 'speak', 'update'],
        alias: { l: 'listen', s: 'speak', u: 'update', h: 'help'  },
        default: { listen: false, speak: false, updates: false },
    });
    // Handle --help option
    if (args.help) {
        printHelp();
        process.exit(1); // error code so that we don't restart
    }

    printWelcome();

    if (args.speak) {
        shouldSpeak = true;
        console.log("Speech enabled");
    }
    if (args.update) {
        shouldUpdate = true;
        console.log("File and command updates enabled");
    }


    dialog = new Dialog2();
    dialog.on('message', handleMessage);
    dialog.on('start_thinking', handleStartThinking);
    dialog.on('thinking', handleThinking);
    dialog.on('done_thinking', handleDoneThinking);

    // If listen flag is true, start microphone listener
    if ( args.listen) {
        await startListening();
    }

    await dialog.setup({
        threadFile: path.resolve(ucDir, '.thread'),
        assistantFile: path.resolve(ucDir, '.assistant'),
        instructionsFile: path.resolve(ucDir, 'instructions.md'),
    });

    rl = await setupReadline({
        '/quit': () => process.exit(1),
        '/reset': async () => {
            console.log('Resetting');
            unlinkSync(path.resolve(ucDir, '.thread'));
            process.exit(0);
        },
        '/rs': () => process.exit(0),
        '/cancel': async () => await dialog.cancelOutstanding(),
    });

    prompt();
}

async function startListening() {
    listener = new Listener();
    listener.on('text', async (text) => {
        if (!text.trim()) {
            return;
        }
        console.log("Transcribed:", text);
        await dialog.addMessage(text, 'transcribedVoice');

        // have some special words that trigger us to send.
        let l = text.toLowerCase();
        if (!working && (l.endsWith("go") || l.endsWith("go.") || l.endsWith("go ahead.") || l.endsWith("please?") || l.endsWith("please."))) {
            working = true;
            if (shouldUpdate) {
                await dialog.addMessage(await getContextMessage());
            }
            await dialog.processRun();
            working = false;
        }

        if (!working) {
            prompt();
        }
    });
    await listener.start();
    console.log("Listening...")
}


function setupReadline(commands) {
    let rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> ',
        terminal: true,
    });

    rl.on('line', async (line) => {
        try {
            working = true;
            if (commands[line]) {
                await commands[line]();
            } else if (line === '') {
                // empty line == go
                if (shouldUpdate) {
                    let contextMessage = await getContextMessage();
                    await dialog.addMessage(contextMessage);
                }
                await dialog.processRun();
                prompt();
            } else {
                await dialog.addMessage(line);
                rl.prompt();
            }
        } finally {
            working = false;
        }
    });

    rl.on('close', () => {
        console.log('Quitting. (rl close)');
        process.exit(1);
    });

    let lastKillTime = +new Date();
    rl.on('SIGINT', async () => {
        let t = +new Date();
        if (t - lastKillTime < 1000) {
            // twice in rapid succession. Let's die for real.
            rl.close();
        } else {
            lastKillTime = t;
            if (working) {
                // we're in the middle of a run. Let's cancel it.
                //console.log('\nCancelling... (ctrl-d quits)');
                await dialog.cancelOutstanding();
            } else {
                // otherwise let's exit cleanly, so we can be restarted if appropriate
                console.log('\nRestarting... (ctrl-d quits)');
                process.exit(0);
            }
        }
    });

    return rl;
}

function prompt() {
    console.log(chalk1(`\n@${dialog.userName}:`));
    rl.prompt(true);
}

function handleThinking({message, chunk, first}) {
    cancelSpinner && cancelSpinner();
    if(first) {
        let roleString;
        if (message.role === 'user') {
            roleString = chalk1(`\n@${dialog.userName}:`) + '\n';
        } else {
            roleString = chalk2(`\n@${dialog.assistant.name}:`) + '\n';
        }
        process.stdout.write(roleString + message.content);
    } else {
        process.stdout.write(chunk);
    }
}

function handleMessage({ role, content, summary, historic, streamed }) {
    if ((!content && !summary)) {
        return;
    }

    if (role === 'user') {
        console.log(chalk1(`\n@${dialog.userName}:`) + '\n' + marked(content).trimEnd());
    }
    else if (role === 'assistant' && !streamed) {

        let c = summary || marked(content).trimEnd();
        console.log(chalk2(`\n@${dialog.assistant.name}:`) + '\n' + c);
        if (!historic && shouldSpeak) {
            speak(content).then();
        }
    } else if (role === 'system' && summary) {
        console.log(chalk3(`\nsystem: ${summary}`));
    } else if (role === 'tool' && summary) {
        console.log(chalk3(`\ntool: ${summary}`));
    }
}

let cancelSpinner;

function handleStartThinking() {
    let s = cliSpinners.dots3;
    let i = 0;
    let spinnerStart = +new Date();
    process.stdout.write('\n');
    let interval = setInterval(() => {
        process.stdout.write(chalk2(`\r ${s.frames[i++ % s.frames.length]} `));
    }, s.interval);

    cancelSpinner = () => {
        clearInterval(interval);
        let t = ((+new Date() - spinnerStart) / 1000).toFixed(0);
        process.stdout.write(`\r ${s.frames[i++ % s.frames.length]} ${t}s\n`);
        cancelSpinner = null;
    };
}

function handleDoneThinking() {
    cancelSpinner && cancelSpinner();
}

async function getContextMessage() {
    const prevInput = lastInput;
    lastInput = +new Date();
    const maxAge = prevInput ? (lastInput - prevInput) / 1000 : 5 * 60;

    let time = new Date().toLocaleDateString('en-US', {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    let commandHistory = (await parseZshHistory(maxAge, 100)).map(c => c.command);
    let changedFiles = getFileChangeSummary(lastInput-maxAge*1000)

    let contextMessage = '<ContextInfo>\n';

    contextMessage += `time: ${time}\ncwd: ${process.cwd()}]\n`;

    if (commandHistory.length) {
        contextMessage += `\nRecent commands:\n${truncateFromStart(commandHistory).join('\n')}`;
    }
    if (changedFiles.length) {
        contextMessage += `\nChanged files:\n${truncateFromStart(changedFiles).join('\n')}\n`;
    }
    contextMessage += '</ContextInfo>';
    //console.log("CBTEST CONTEXT", contextMessage);
    return {
        role: 'system',
        content: contextMessage,
        summary: `Context ${commandHistory.length} commands run, ${changedFiles.length} files changed`,
    }
}

function truncateFromStart(list, len=5) {
    if (list.length <= len) {
        return list;
    }
    return [ `...${list.length-len} not shown`, ...list.slice(list.length - len)];
}

function printWelcome() {
    console.log('\n');
    console.log('╔═════════════════════════════════════════╗');
    console.log('║ Welcome to the Universal Constructor!   ║');
    console.log('║ ‾‾‾‾‾‾‾                                 ║');
    console.log('║ ctrl+c to cancel/restart                ║');
    console.log('║ /reset gets you a fresh thread          ║');
    console.log('║ you gotta hit enter twice               ║');
    console.log('║                                         ║');
    console.log('║ have fun <3                             ║');
    console.log('╚═════════════════════════════════════════╝');
}

function printHelp() {
    console.log(`Usage: uc [options]\n`);
    console.log(`Options:`);
    console.log(`  --listen, -l          Listen for voice input via microphone (default: false)`);
    console.log(`  --speak, -s           Speak out the content (default: false)`);
    console.log(`  --updates, -u         Perform file & command-line updates (default: false)`);
    console.log(`  --help, -h            Display this help message and exit`);
}

// run the main function
await main();
