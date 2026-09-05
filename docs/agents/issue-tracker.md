# Issue tracker: GitHub

Issues and specs live in Jcoderdude2345/VectFox.
Use the gh CLI with --repo Jcoderdude2345/VectFox explicitly,
because this clone also has an upstream remote.

- Publish a ticket: gh issue create.
- Fetch a ticket: gh issue view <number> --comments.
- List tickets: gh issue list, including body, labels, and comments
  when needed for triage.
- Comment: gh issue comment <number>.
- Change labels or assignees: gh issue edit <number>.
- Close: gh issue close <number>.

For multiline issue bodies and comments, write the text to a
temporary file and pass --body-file.

## Pull requests as a triage surface

PRs as a request surface: no.

## Wayfinding

Use one issue labelled wayfinder:map as the map.
Link child tickets as sub-issues; where unavailable, use a task
list in the map and a Part of #<map> line in each child.

Use wayfinder:research, wayfinder:prototype, wayfinder:grilling,
or wayfinder:task labels for children.

Record blockers using native issue dependencies where available,
otherwise a Blocked by: #<number> line. A ticket is unblocked
when every blocker is closed.

Choose the first open, unassigned, unblocked child in map order.
Claim it by assigning the driving developer. On resolution,
comment with the result, close the ticket, and append a summary
and link to the map's Decisions-so-far.
