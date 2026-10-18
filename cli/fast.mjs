// A string quoted for a POSIX shell: single quotes, each ' written as '\''.
// Every path atelier fast take prints for the developer to run goes through
// it: JSON.stringify's double quotes left $ and backticks to the shell, so a
// repository at /tmp/project-$batch had $batch expanded and the command ran
// elsewhere.
export const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
