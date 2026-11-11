## Output format

Call `ModelDraft` exactly once with the complete model as raw SQL in `sql` and optional short text in
`notes`. SQL and notes are separate fields: never put Markdown fences, explanations, links or file paths
in `sql`. Include every required field and CTE. Do not claim the file was saved or validated, or that all fields are present; those steps
run after you return the draft. Do not call any other function or return multiple drafts.
