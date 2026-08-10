# Net-worth chart geometry diagnosis

- Requested: Review the attached chart screenshot and explain why the selected guide, dot, and line still look incorrect.
- Done: Inspected the screenshot, current `NetWorth` SVG composition, styles, and chart helper. No runtime code was changed; added the proposed cleanup to `backlog.md`.
- Approach: Reproduced the layout mathematically at the attached width. Chart points use endpoint spacing while month labels use cell-centre spacing, placing April 22.9px left of its label. Stretching a 100x100 SVG to a 458x180 plot also turns the nominal circle into an approximately 8.2x3.2px oval and distorts stroke treatment.
- Validation: Ran a deterministic Node geometry check covering the month offset and marker aspect ratio; both reproduced the reported defects. Runtime tests were not run because this task was diagnosis only.
- Follow-up: Align points to label-cell centres, use a fixed-size overlay marker, and apply rounded non-scaling strokes with a quieter fill; then visually verify desktop and mobile.
