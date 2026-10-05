#!/bin/sh
# bin/control-plane: this project works through Atelier.
#
# `atelier adopt` wrote this file in place of ControlPlane's launcher for the
# central Python checkout. It prints the Atelier command it runs to stderr and
# runs it. It never contacts ControlPlane's checkout, its tools or its state.
set -eu

# Filled in when the project was adopted, as one single-quoted shell word.
atelier_project=__ATELIER_PROJECT__

# What each ControlPlane command became, kept in the project so the list
# travels with it and `bin/control-plane help` answers on its own.
mappings() {
  cat <<TEXT
This project works through Atelier, not ControlPlane. Several agents may work
on it at once, each task has exactly one owner, and the project owner accepts
and merges the work. bin/control-plane forwards what this project used to run:

  pickup-card                    atelier status --project $atelier_project
  wrap, session-receipt          atelier done "summary"
  report TEXT                    atelier new TEXT --project $atelier_project
  audit, context-budget, ship-check, observe, observatory-bundle,
  observatory-run, backup-status, validate-backup
                                 atelier ops COMMAND [ARGUMENTS]

Run atelier help for the tasks, and atelier ops help for the operations.
TEXT
}

run() {
  printf 'control-plane: running: atelier %s\n' "$*" >&2
  exec atelier "$@"
}

sub="${1:-}"
if [ $# -gt 0 ]; then shift; fi

case "$sub" in
  ""|help) mappings ;;
  pickup-card) run status --project "$atelier_project" ;;
  wrap|session-receipt) run done "$@" ;;
  report) run new "$@" --project "$atelier_project" ;;
  audit|context-budget|ship-check|observe|observatory-bundle|observatory-run|backup-status|validate-backup) run ops "$sub" "$@" ;;
  *)
    printf 'control-plane: %s moved into Atelier; this project no longer runs ControlPlane.\n' "$sub" >&2
    printf 'control-plane: see atelier help, and atelier ops help for the operations commands.\n' >&2
    exit 2
    ;;
esac
