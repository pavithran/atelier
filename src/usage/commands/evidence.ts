import type { CommandSpec } from "../command.ts";
import { CLAIM_MAX, OUTPUT_MAX } from "../../text.ts";

const spec: CommandSpec = {
  name: "evidence",
  // The route is new with t497; a server without it answers 404.
  forms: [
    {
      group: "Developer", line: 1, slot: 57,
      form: `evidence ID --head SHA --note TEXT [--file PATH] [--quote WORDS --as H/M] (note: up to ${CLAIM_MAX} characters)`,
      about: `The orchestrator, acting for the developer, records text evidence at the task's recorded head: a run or a look made on a machine the builder cannot reach, such as a full suite run on the Mac or the developer looking at a render. The review brief at that head lists it under a heading of its own, apart from Reports, and says it may count toward a criterion that names the run or result it describes. It is never a required check, and the gate does not change. The developer token only, with the acting model named by --as H/M or ATELIER_ACTING. A note over ${CLAIM_MAX} characters is refused, not cut. --file keeps the file's last ${OUTPUT_MAX} characters and says when it was cut; a file that cannot be read is refused before anything is sent. --quote WORDS stores the developer's words beside it, as atelier decide does. The head must be the task's recorded head, and a merged or abandoned task takes nothing. The same head, note, words and file sent again records nothing new and says it is already recorded. Text only; images are not kept.`,
    },
  ],
  flags: {
    head: "--head needs the task's head: atelier evidence ID --head SHA --note TEXT",
    note: "--note needs the evidence's text: atelier evidence ID --head SHA --note TEXT",
    file: "--file needs a path: atelier evidence ID --head SHA --note TEXT --file PATH",
    quote: '--quote needs the developer\'s words: atelier evidence ID --head SHA --note TEXT --quote "what the developer said" --as H/M',
  },
  help: {
    flags: {
      "--head SHA": "the task's recorded head, in full; evidence at any other head is refused",
      "--note TEXT": `what was run or seen and its result; required, at most ${CLAIM_MAX} characters`,
      "--file PATH": `a file of the run's output; its last ${OUTPUT_MAX} characters are kept, and the cut is said`,
      "--quote WORDS": "the developer's own words, stored beside the evidence; with --as H/M, the model that relayed them",
      "--as H/M": "the harness/model acting for the developer; ATELIER_ACTING can name it instead",
    },
    example: 'ATELIER_ACTING=claude-code/opus-5.5 atelier evidence t105 --head 0123456789abcdef0123456789abcdef01234567 --note "Journey suite on the Mac: 226 passed, 0 failed" --file .scratch/journey.log --project miqra',
  },
};

export default spec;
