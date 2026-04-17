import readline from "node:readline";
import { stdin, stdout } from "node:process";

export async function confirm(opts: {
  message: string;
  default?: boolean;
}): Promise<boolean> {
  const def = opts.default ?? false;
  const hint = def ? "[Y/n]" : "[y/N]";
  const prompt = `${opts.message} ${hint} `;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await new Promise<boolean>((resolve) => {
      const ask = () => stdout.write(prompt);
      rl.on("line", (line) => {
        const ans = line.trim().toLowerCase();
        if (ans === "") return resolve(def);
        if (ans === "y" || ans === "yes") return resolve(true);
        if (ans === "n" || ans === "no") return resolve(false);
        stdout.write(`Please answer "y" or "n".\n`);
        ask();
      });
      rl.on("close", () => resolve(def));
      ask();
    });
  } finally {
    rl.close();
  }
}
