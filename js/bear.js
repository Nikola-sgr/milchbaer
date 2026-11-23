/*
 * Milchbär – der Bär als schlichte Linien-Illustration.
 * Farben kommen aus CSS-Variablen (--bear-line, --bear-fill, --bear-soft, --bear-blush).
 */
(function (root) {
  'use strict';

  const face = `
      <g class="b-cheeks">
        <circle cx="86" cy="113" r="8.5"/>
        <circle cx="154" cy="113" r="8.5"/>
      </g>
      <g class="b-eyes">
        <circle cx="100" cy="93" r="5"/>
        <circle cx="140" cy="93" r="5"/>
      </g>
      <ellipse class="b-soft b-line" cx="120" cy="117" rx="22" ry="16"/>
      <path class="b-nose" d="M111.5 109.5q8.5-5 17 0q-2.5 7-8.5 8q-6-1-8.5-8z"/>
      <path class="b-line b-open" d="M120 117.5v4.5M120 122q-5 5.5-10 2M120 122q5 5.5 10 2"/>`;

  const head = `
    <g class="b-head">
      <circle class="b-fill b-line" cx="76" cy="57" r="21"/>
      <circle class="b-fill b-line" cx="164" cy="57" r="21"/>
      <circle class="b-soft" cx="76" cy="57" r="10"/>
      <circle class="b-soft" cx="164" cy="57" r="10"/>
      <circle class="b-fill b-line" cx="120" cy="97" r="56"/>
      ${face}
    </g>`;

  const body = `
    <g class="b-body">
      <ellipse class="b-fill b-line" cx="120" cy="194" rx="60" ry="52"/>
      <ellipse class="b-soft" cx="120" cy="203" rx="33" ry="29"/>
      <path class="b-line b-open" d="M79 170c-6 20 3 37 23 42M161 170c6 20-3 37-23 42"/>
      <ellipse class="b-fill b-line" cx="84" cy="239" rx="22" ry="12.5"/>
      <ellipse class="b-fill b-line" cx="156" cy="239" rx="22" ry="12.5"/>
    </g>`;

  function bearSVG(variant) {
    if (variant === 'head') {
      return `<svg class="bear bear-head" viewBox="40 22 160 150" aria-hidden="true" focusable="false">${head}</svg>`;
    }
    return `<svg class="bear" viewBox="0 0 240 258" aria-hidden="true" focusable="false">${body}${head}</svg>`;
  }

  root.MB = root.MB || {};
  root.MB.bearSVG = bearSVG;
})(typeof self !== 'undefined' ? self : globalThis);
