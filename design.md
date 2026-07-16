# LectureLink design system

## Direction

LectureLink should feel like a calm, credible medical study instrument: precise enough for exam preparation, warm enough for daily repetition. Avoid generic SaaS marketing cards, decorative pills, glass effects, and celebratory motion.

## Structure

- Public pages: Workbench family. Explain the study loop through a working product surface rather than a feature-card catalogue.
- Signed-in pages: task-first application frame. Navigation supports the current study job; it must not resemble a marketing navbar.
- Dashboard: one dominant next action, a compact weekly record, then a ranked study queue. Avoid equal three-card rows.

## Typography

- Korean body and UI: Pretendard Variable.
- Display: Pretendard Variable used with tighter measure, heavier weight, and deliberate line breaks. Never italicize headings.
- Numeric data always uses tabular figures.

## Color

- Warm paper foundation, pine ink and action color, sparing coral for the single urgent action.
- All colors are defined in `tokens.css`; components consume semantic tokens only.

## Components

- Cards are reserved for bounded data or controls, not every paragraph.
- Buttons are one line, use an immediate focus ring, and animate transform or opacity only.
- Section labels are off by default. Use headings and spacing to communicate hierarchy.
- Icons sit inline with labels; avoid colored icon tiles.

## Motion

- One restrained first-load reveal is allowed on the public page.
- No universal scroll-triggered fade-up.
- Respect `prefers-reduced-motion` and keep focus indicators instant.
