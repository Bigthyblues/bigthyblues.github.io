# Questions

Questions are part of the main Astro project:

- Page: `src/pages/questions.astro`
- Styles: `src/styles/questions.css`
- Answers: `src/content/questions/*.md`
- Images: `public/img/questions/`

Use the local editor's **Page MD** menu to load a question or **Questions / New question**. Download the edited Markdown and save it in `src/content/questions/` under its existing filename, or a new filename for a new answer.

`title` is the question, `author` is the requester's name, and `date` is the answer date. `number` must be a positive integer and controls descending display order. Set `draft: false` to publish; `draft: true` hides a draft. Images use `/img/questions/filename.png`; `images` also supports multiple images.

Run `npm run build` to validate content and generate the site. A push to `main` publishes through the existing GitHub Pages workflow. The editor remains a local tool; the home buttons are unchanged.
