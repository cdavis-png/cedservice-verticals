/* CED Service — mobile header navigation toggle.
   Shared page chrome, identical across verticals. Kept out of the assessment
   engine so that engine stays scoped to the review.

   Classic script on purpose — see the note in shared/assessment-engine/engine.js. */

(() => {
  'use strict';

  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.site-nav');
  if (!toggle || !nav) return;

  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-expanded', String(nav.classList.toggle('open')));
  });
})();
