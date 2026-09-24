import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

/** A fixed synthetic HEAD and index, without running git commit or any hooks. */
export async function createGitFixture(dir: string): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = (...args: string[]) => promisify(execFile)("git", ["-C", dir, ...args], { env, timeout: 2000 });
  await mkdir(dir, { recursive: true });
  await git("init", "--quiet", "--object-format=sha1");

  const object = async (type: string, content: Buffer): Promise<string> => {
    const data = Buffer.concat([Buffer.from(`${type} ${content.length}\0`), content]);
    const id = createHash("sha1").update(data).digest("hex");
    const parent = join(dir, ".git", "objects", id.slice(0, 2));
    await mkdir(parent, { recursive: true });
    await writeFile(join(parent, id.slice(2)), deflateSync(data));
    return id;
  };
  const files = [
    { name: "dirty-link.txt", content: "tracked.txt", link: true },
    { name: "piece1.txt", content: "one\n", link: false },
    { name: "tracked-link.txt", content: "untracked.txt", link: true },
    { name: "tracked.txt", content: "one\n", link: false },
  ];
  const tree: Buffer[] = [];
  for (const file of files) {
    const blob = await object("blob", Buffer.from(file.content));
    tree.push(Buffer.from(`${file.link ? "120000" : "100644"} ${file.name}\0`), Buffer.from(blob, "hex"));
    if (file.link) await symlink(file.content, join(dir, file.name));
    else await writeFile(join(dir, file.name), file.content);
  }
  const treeId = await object("tree", Buffer.concat(tree));
  const head = await object("commit", Buffer.from(
    `tree ${treeId}\nauthor Test <test@example.invalid> 0 +0000\ncommitter Test <test@example.invalid> 0 +0000\n\nSynthetic fixture\n`,
  ));
  await writeFile(join(dir, ".git", "HEAD"), `${head}\n`);
  await git("read-tree", "HEAD");
}
