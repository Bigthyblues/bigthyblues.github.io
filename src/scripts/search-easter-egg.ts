const EASTER_EGG_QUERY = "BARFK BARFK";
const EASTER_EGG_MESSAGE = "Woof?!🐶";
const EASTER_EGG_URL = "https://bsky.app/profile/longnecklupin.bsky.social/post/3lci2p6nqfs2g";
const EASTER_EGG_DELAY_MS = 900;

export function attachSearchEasterEgg(search: Element | null | undefined, clearButton?: Element | null) {
  if (!(search instanceof HTMLInputElement)) return;

  let isRedirecting = false;

  search.addEventListener("keydown", (event) => {
    if (
      !(event instanceof KeyboardEvent) ||
      event.key !== "Enter" ||
      event.isComposing ||
      isRedirecting ||
      search.value !== EASTER_EGG_QUERY
    ) return;

    event.preventDefault();
    event.stopPropagation();
    isRedirecting = true;
    search.value = EASTER_EGG_MESSAGE;
    search.readOnly = true;

    if (clearButton instanceof HTMLButtonElement) clearButton.hidden = true;

    window.setTimeout(() => {
      window.location.assign(EASTER_EGG_URL);
    }, EASTER_EGG_DELAY_MS);
  });
}
