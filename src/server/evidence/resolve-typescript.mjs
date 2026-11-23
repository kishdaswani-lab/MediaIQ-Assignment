import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const evidenceRoot = `${path.sep}src${path.sep}server${path.sep}evidence${path.sep}`;
const miaRoot = `${path.sep}src${path.sep}server${path.sep}mia${path.sep}`;
const uiRoot = `${path.sep}src${path.sep}components${path.sep}evidence${path.sep}`;
const reservationRoot = `${path.sep}src${path.sep}components${path.sep}reservations${path.sep}`;
const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "src");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only" && process.env.MEDIAIQ_REQUIRE_SERVER_ONLY !== "1" && importsTestModule(context.parentURL)) {
    return { url: "data:text/javascript,export {}", shortCircuit: true };
  }
  if (importsTestModule(context.parentURL) && specifier.startsWith("@/")) {
    const target = path.join(srcRoot, specifier.slice(2));
    return nextResolve(pathToFileURL(`${target}.ts`).href, context);
  }
  if (importsTestModule(context.parentURL) && specifier.startsWith(".") && path.extname(specifier) === "") {
    return nextResolve(`${specifier}.ts`, context);
  }
  return nextResolve(specifier, context);
}

function importsTestModule(parentURL) {
  if (!parentURL?.startsWith("file:")) {
    return false;
  }
  const parent = fileURLToPath(parentURL);
  return parent.includes(evidenceRoot) || parent.includes(uiRoot) || parent.includes(miaRoot) || parent.includes(reservationRoot);
}
