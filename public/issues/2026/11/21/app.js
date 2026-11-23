const collapseButton = document.querySelector('#collapse-all');
const allDetails = [...document.querySelectorAll('details')];

// All content is readable without JavaScript; JS only adds convenience controls.
collapseButton.hidden = false;
collapseButton.addEventListener('click', () => {
  allDetails.forEach(detail => { detail.open = false; });
  // Remove the deep link so reloading after collapse keeps everything closed.
  if (location.hash) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* file:// compatibility */ }
  }
});

function revealLinkedStory() {
  const id = location.hash.slice(1);
  const story = document.getElementById(id);
  if (!story?.matches('details.story')) return;
  story.open = true;
  requestAnimationFrame(() => story.scrollIntoView({ block: 'start' }));
}
window.addEventListener('hashchange', revealLinkedStory);
revealLinkedStory();
