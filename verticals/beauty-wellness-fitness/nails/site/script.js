const modal = document.querySelector('.review-modal');
const startButtons = document.querySelectorAll('.js-start-review');
const closeButton = document.querySelector('.modal-close');
const backdrop = document.querySelector('.modal-backdrop');
const form = document.getElementById('growthReview');
const steps = [...document.querySelectorAll('.review-step')];
const nextButton = document.getElementById('nextStep');
const prevButton = document.getElementById('prevStep');
const progressText = document.getElementById('progressText');
const progressBar = document.getElementById('progressBar');
const navToggle = document.querySelector('.nav-toggle');
const nav = document.querySelector('.site-nav');
let currentStep = 1;

const STORAGE_KEY = 'cedSalonGrowthReview';

function openReview() {
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  loadSaved();
  showStep(currentStep);
}
function closeReview() {
  saveForm();
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}
startButtons.forEach(btn => btn.addEventListener('click', openReview));
closeButton.addEventListener('click', closeReview);
backdrop.addEventListener('click', closeReview);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && modal.classList.contains('open')) closeReview(); });

navToggle.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', String(open));
});

function showStep(n) {
  steps.forEach(step => step.classList.toggle('active', Number(step.dataset.step) === n));
  progressText.textContent = `Step ${n} of ${steps.length}`;
  progressBar.style.width = `${(n / steps.length) * 100}%`;
  prevButton.style.visibility = n === 1 ? 'hidden' : 'visible';
  nextButton.style.display = n === steps.length ? 'none' : 'inline-flex';
  nextButton.textContent = n === steps.length - 1 ? 'See My Results' : 'Continue';
  currentStep = n;
}

function currentStepValid() {
  const active = steps[currentStep - 1];
  const required = [...active.querySelectorAll('[required]')];
  return required.every(field => field.reportValidity());
}

nextButton.addEventListener('click', () => {
  if (!currentStepValid()) return;
  saveForm();
  if (currentStep === steps.length - 1) calculateResults();
  showStep(Math.min(steps.length, currentStep + 1));
});
prevButton.addEventListener('click', () => showStep(Math.max(1, currentStep - 1)));

form.addEventListener('input', saveForm);

function saveForm() {
  const data = Object.fromEntries(new FormData(form).entries());
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ data, currentStep }));
}

function loadSaved() {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  if (!saved) return;
  Object.entries(saved.data || {}).forEach(([key, value]) => {
    const field = form.elements[key];
    if (field) field.value = value;
  });
  currentStep = Math.min(Number(saved.currentStep || 1), steps.length - 1);
}

const num = name => Number(form.elements[name]?.value || 0);
const val = name => form.elements[name]?.value || '';

function calculateResults() {
  const ticket = num('averageTicket');
  const days = num('daysOpen');
  const missed = num('missedCallsDay');
  const noShows = num('noShowsWeek');
  const cancels = num('cancelsWeek');
  const inactive = num('inactiveClients');

  const missedProcess = num('missedCallProcess');
  const reminders = num('reminders');
  const waitlist = num('waitlist');
  const rebooking = num('rebooking');
  const reactivation = num('reactivation');
  const reviewRequests = num('reviewRequests');
  const promotions = num('promotions');

  const missedOpportunity = missed * .35 * ticket * days;
  const noShowOpportunity = noShows * ticket * 4.33 * Math.max(.2, (3 - reminders) * .18);
  const cancellationOpportunity = cancels * ticket * 4.33 * Math.max(.15, (2 - waitlist) * .18);
  const reactivationOpportunity = inactive * .06 * ticket * Math.max(.25, (3 - reactivation) / 3);
  const total = missedOpportunity + noShowOpportunity + cancellationOpportunity + reactivationOpportunity;

  const missedScore = Math.min(100, missedProcess * 28 + (missed === 0 ? 16 : 0));
  const appointmentScore = Math.min(100, reminders * 24 + waitlist * 12);
  const retentionScore = Math.min(100, rebooking * 22 + reactivation * 20);
  const reputationScore = Math.min(100, reviewRequests * 30 + (num('rating') >= 4.6 ? 10 : 0));
  const marketingScore = Math.min(100, promotions * 30);
  const score = Math.round(
    missedScore * .25 + appointmentScore * .25 + retentionScore * .20 +
    reputationScore * .15 + marketingScore * .15
  );

  const priorities = [];
  if (missedScore < 65) priorities.push('Recover missed calls and inquiries automatically.');
  if (appointmentScore < 65) priorities.push('Automate reminders and fill last-minute cancellations.');
  if (retentionScore < 65) priorities.push('Create consistent rebooking and client-reactivation follow-up.');
  if (reputationScore < 65) priorities.push('Request and respond to Google reviews consistently.');
  if (marketingScore < 65) priorities.push('Run trackable promotions to past clients.');
  while (priorities.length < 3) priorities.push('Track appointment sources and conversion more consistently.');

  const techs = num('technicians');
  let pkg = 'Salon Growth — $597/month';
  let reason = 'Recommended for established salons with appointment, retention, and follow-up opportunities.';
  if (techs <= 1 && total < 1000) {
    pkg = 'Starter — $297/month';
    reason = 'Recommended for a solo provider that needs basic missed-call, review, and reactivation automation.';
  } else if (techs >= 5 && (num('callsDay') >= 12 || missed >= 4)) {
    pkg = 'Scale — $997/month';
    reason = 'Recommended for a multi-technician salon with enough call volume to justify AI phone coverage and active growth support.';
  }

  document.getElementById('resultSalon').textContent = val('salonName') || 'Your salon';
  document.getElementById('growthScore').textContent = score;
  document.getElementById('monthlyOpportunity').textContent = total.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  document.getElementById('recommendedPackage').textContent = pkg;
  document.getElementById('recommendationReason').textContent = reason;
  document.getElementById('priorityList').innerHTML = priorities.slice(0,3).map((p,i) => `<div class="priority"><b>0${i+1}</b><span>${p}</span></div>`).join('');
  saveForm();
}
