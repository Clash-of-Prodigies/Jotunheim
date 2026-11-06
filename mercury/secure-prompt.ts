import { stdin, stdout } from "node:process";

function readHiddenLine(prompt: string): Promise<string> {
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
        throw new Error(
            "Challenge Place publishing requires an interactive terminal for secure token entry.",
        );
    }
    stdout.write(prompt);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    return new Promise((resolve, reject) => {
        let value = "";
        let settled = false;
        const cleanup = () => {
            if (settled) return;
            settled = true;
            stdin.off("data", onData);
            if (!wasRaw) stdin.setRawMode(false);
            stdin.pause();
            stdout.write("\n");
        };
        const cancel = () => {
            cleanup();
            reject(new Error("Challenge Place token entry was cancelled."));
        };
        const onData = (chunk: Buffer | string) => {
            for (const character of String(chunk)) {
                if (character === "\u0003" || character === "\u0004") {
                    cancel();
                    return;
                }
                if (character === "\r" || character === "\n") {
                    cleanup();
                    resolve(value.trim());
                    return;
                }
                if (character === "\u0008" || character === "\u007f") {
                    value = value.slice(0, -1);
                } else if (character >= " ") {
                    value += character;
                }
            }
        };
        stdin.on("data", onData);
    });
}

export async function promptForChallengePlaceTokenId(): Promise<string> {
    while (true) {
        const tokenId = await readHiddenLine("Challenge Place token ID: ");
        if (tokenId.length > 0) return tokenId;
        stdout.write("A token ID is required while publishing is enabled.\n");
    }
}
