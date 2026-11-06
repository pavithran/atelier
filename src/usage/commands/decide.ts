import type { CommandSpec } from "../command.ts";

const spec: CommandSpec = {
  name: "decide",
  forms: [
    {
      group: "Developer", line: 4, slot: 10,
      form: "decide \"text\" --quote \"developer's words\" [--project P] [--as H/M]",
      about: "The developer records a standing decision for the project, dated, with their own words it rests on: another company reviews everywhere, the review bar, a spend limit, no overrides. Only the developer's token records one; `--as` names the harness/model recording it for the developer, kept beside them. Every review brief of the project and `atelier guide --role orchestrate` carry the decisions that stand, marked as decisions a reviewer must not overrule.",
    },
    {
      group: "Developer", line: 4, slot: 15,
      form: "decide --standing KEY VALUE --quote \"developer's words\" [--project P] [--as H/M]",
      about: "The developer records a standing instruction: models TEXT sets the model, role and effort plan that unwrap prints in either mode. dispatch-on-criteria harness/model|off dispatches an undispatched task home to that builder after criteria approval, once core-file holds and open-question blocks clear, in either mode. The other automatic actions require fast mode: queue-landable on|off (the tick queues a landable task's landing), reask-on-resubmit on|off (a review request the head moved past is asked again of the same reviewer), review-on-checked company=H/M,...|off (the tick asks the reviewer mapped to the builder's company when checks pass, for example anthropic=codex/gpt-6-astra,openai=claude-code/sonnet-5.5), post-merge-reviewer H/M|off (a fast landing's post-merge review is asked of that reviewer), notice-delay MINUTES (when a stuck episode is sent). One stands per key; `atelier decisions` lists them and `atelier decisions withdraw ID --note` withdraws one. Outside fast mode models and dispatch-on-criteria can be recorded.",
    },
  ],
  flags: {
    quote: "--quote needs the developer's words: atelier decide \"text\" --quote \"what the developer said\"",
    standing: "--standing names the instruction: atelier decide --standing KEY VALUE --quote \"what the developer said\"",
  },
  help: {
    flags: {
      "--quote TEXT": "the developer's own words the decision rests on; required, at most 2000 characters",
      "--project NAME": "the project the decision is for; this checkout's or workspace's project unless given",
      "--as H/M": "the harness/model recording the decision for the developer, kept beside them as its acting model",
      "--standing KEY": "a standing instruction in place of the text, KEY followed by its VALUE: queue-landable on|off, reask-on-resubmit on|off, review-on-checked company=H/M,...|off, post-merge-reviewer H/M|off, notice-delay MINUTES (fast mode only); models TEXT (session plan in either mode); dispatch-on-criteria harness/model|off (dispatch after criteria approval in either mode)",
    },
    example: 'ATELIER_ACTING=claude-code/opus-5.5 atelier decide "Every change is reviewed by a model of another company" --quote "another company reviews everywhere" --project demo',
  },
};

export default spec;
