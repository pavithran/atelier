// atelier login. Its forms, flags and help are declared in src/usage/commands/login.ts.
import { describeStore, promptSecret, writeSecret } from "../credentials.mjs";
import { COMMAND_USAGE } from "../help.mjs";
import { args, call, cfg, cliState, die, insecureServer, saveConfig, server, storedToken, trimSlash } from "../atelier.mjs";

export default async function loginCommand() {
  if (args.store) {
    const held = storedToken();
    const env = process.env.ATELIER_TOKEN?.trim() ? " ATELIER_TOKEN is set in the environment and is used instead." : "";
    return console.log(`The token store is ${describeStore("API_TOKEN")}. ${held ? "A token is stored." : "No token is stored."}${env}`);
  }
  if (!args.server || args.server === true) die(COMMAND_USAGE.login);
  const target = trimSlash(args.server);
  // Refused before a token is asked for or sent anywhere.
  const insecure = insecureServer(target);
  if (insecure) die(insecure);
  // The stored token and the server config.json names are a pair: the token
  // was stored when that server accepted it, and apiToken sends it there
  // alone. ATELIER_TOKEN is the user's own pair with the server in use,
  // ATELIER_SERVER or else the one config.json names. Login sends the named
  // server only a token already paired with it: ATELIER_TOKEN when its
  // server is the named one, else the stored token when config.json names
  // it, and otherwise asks for one. So a token never reaches a server it was
  // not given for: a typo in --server would otherwise hand the owner token
  // to whatever host answers there.
  const home = cfg.server ? trimSlash(cfg.server) : null;
  const fromEnv = process.env.ATELIER_TOKEN?.trim();
  const envServer = process.env.ATELIER_SERVER ? trimSlash(process.env.ATELIER_SERVER) : home;
  let token = null, from = null;
  if (fromEnv && target === envServer) { token = fromEnv; from = "ATELIER_TOKEN"; }
  else if (target === home) { token = storedToken(); if (token) from = "store"; }
  if (!token) {
    if (home && target !== home) process.stderr.write(`atelier: ${target} is not ${home}, the server the stored token belongs to; a token for ${target} is needed.\n`);
    try { token = await promptSecret("Server token (not shown): "); } catch (error) { die(`no token entered: ${error.message}`); }
    if (!token) die("no token entered");
    from = "typed";
  }
  // Nothing is saved until the server accepts the token: `call` ends the
  // command on a refusal or a server that cannot answer, and config.json and
  // the store stay as they were.
  cliState.loginToken = token;
  cliState.loginServer = target;
  const conf = await call("GET", "/config", undefined, "owner");
  // Accepted. The pair is rewritten whole or not at all: whenever config.json
  // is about to name a server other than the stored token's, or the token was
  // typed, the accepted token goes to the store first and config.json names
  // the server after. A token ATELIER_TOKEN holds is stored on that path too;
  // leaving the store alone there would pair the old token with the new
  // server, and the next command without ATELIER_TOKEN would send it there.
  // A token reused for the server config.json already names leaves the store
  // as it is.
  const store = from === "typed" || target !== home;
  let where;
  if (store) { try { where = writeSecret("API_TOKEN", token); } catch (error) { die(error.message); } }
  else where = from === "ATELIER_TOKEN" ? "the ATELIER_TOKEN environment variable" : describeStore("API_TOKEN");
  cfg.server = target;
  cfg.owner = conf.ownerActor;
  cfg.ownerName = conf.ownerName ?? undefined;
  try { saveConfig(cfg); } catch (error) { die(`the token is stored, but config.json could not be written (${error.message}); run login again`); }
  const what = from === "ATELIER_TOKEN" && store ? "The token, from ATELIER_TOKEN," : "The token";
  console.log(`Signed in to ${cfg.server} as the project owner, actor "${cfg.owner}". ${what} ${store ? "is now stored in" : "is read from"} ${where}.`);
  if (from === "typed" && fromEnv) console.log("ATELIER_TOKEN is set in the environment and is used instead of the stored token until it is unset.");
}
