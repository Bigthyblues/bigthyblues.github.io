# Questions

Questions are part of the main Astro project:

- Page: `src/pages/questions.astro`
- Styles: `src/styles/questions.css`
- Answers: `src/content/questions/*.md`
- Images: `public/img/questions/`

Use the local editor's **Question** mode to edit the question, requester, answer date, number, images, draft status, and optional answer text. Existing questions from the site menu or local Markdown files automatically open in this mode. **New question** starts a blank draft; **Auto number** uses the highest existing number plus one, including drafts, to avoid collisions. The current file count and next number are shown. Downloads advance the suggested number for the next question in this session. Refresh after saving new Markdown into the content directory to update the file count.

Download the edited Markdown and save it in `src/content/questions/`. New files use `YYYY-MM-DD-question-N.md`; existing filenames and extra metadata are preserved. One image uses `image`, multiple images use `images`, and image-only answers may leave the body empty.

`title` is the question, `author` is the requester's name, and `date` is the answer date. `number` must be a positive integer and controls descending display order. Set `draft: false` to publish; `draft: true` hides a draft. Images use `/img/questions/filename.png`; `images` also supports multiple images.

Run `npm run build` to validate content and generate the site. A push to `main` publishes through the existing GitHub Pages workflow. The editor remains a local tool.
