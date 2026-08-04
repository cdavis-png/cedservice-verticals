# CED Service Salon Growth Website Prototype

This is a self-contained, mobile-responsive prototype for the Nail Salon vertical.

## Files
- `index.html` — complete landing page and self-paced assessment
- `styles.css` — responsive CED Service visual system
- `script.js` — navigation, assessment, pause/resume, scoring, and recommendation logic

## Preview locally
Open `index.html` directly in a browser, or run:

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

## Before publishing
1. Replace the email/phone if needed.
2. Connect the in-person CTA to the final calendar.
3. Connect the review results to the CRM/backend.
4. Replace localStorage-only saving with server-side progress storage if cross-device resume is required.
5. Confirm the production domain. Recommended: `nails.cedservice.com`.
6. Add analytics and separate campaign links for cards and one-pagers.
7. Add privacy policy and terms links.
8. Test all calculations and compliance language.

## Clone strategy
Use this as the master for:
- Hair salons
- Barbershops
- Massage therapists
- Spas / estheticians
- Gyms
- Personal trainers

Change the industry copy, assessment questions, package names, and imagery while preserving the design system.
