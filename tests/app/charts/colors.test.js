// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  SOLUTION_COLORS,
  getBuyPriceColor,
  toRGBA,
  dim,
} from '../../../app/src/charts/colors.js';

describe('SOLUTION_COLORS', () => {
  it('exposes the documented flow colors', () => {
    expect(SOLUTION_COLORS.b2g).toBe('rgb(15, 192, 216)');
    expect(SOLUTION_COLORS.g2l).toBe('rgb(233, 122, 131)');
    expect(SOLUTION_COLORS.ev_charge).toBe('rgb(16, 185, 129)');
  });
});

describe('getBuyPriceColor', () => {
  it('uses fixed colors at the scale stops', () => {
    expect(getBuyPriceColor(-10)).toBe('rgb(37, 99, 235)');
    expect(getBuyPriceColor(-1)).toBe('rgb(96, 165, 250)');
    expect(getBuyPriceColor(0)).toBe('rgb(226, 232, 240)');
    expect(getBuyPriceColor(1)).toBe('rgb(254, 243, 199)');
    expect(getBuyPriceColor(12)).toBe('rgb(251, 191, 36)');
    expect(getBuyPriceColor(24)).toBe('rgb(249, 115, 22)');
    expect(getBuyPriceColor(35)).toBe('rgb(220, 38, 38)');
  });

  it('clips prices below the first and above the last stop', () => {
    expect(getBuyPriceColor(-50)).toBe('rgb(37, 99, 235)');
    expect(getBuyPriceColor(90)).toBe('rgb(220, 38, 38)');
  });

  it('interpolates between stops in OKLab space', () => {
    expect(getBuyPriceColor(-5.5)).toBe('rgb(65, 133, 243)');
    expect(getBuyPriceColor(6.5)).toBe('rgb(253, 218, 133)');
    expect(getBuyPriceColor(30)).toBe('rgb(234, 78, 34)');
  });

  it('treats non-finite prices as neutral', () => {
    expect(getBuyPriceColor(null)).toBe('rgb(226, 232, 240)');
    expect(getBuyPriceColor(Number.NaN)).toBe('rgb(226, 232, 240)');
    expect(getBuyPriceColor('not-a-number')).toBe('rgb(226, 232, 240)');
    expect(getBuyPriceColor(Infinity)).toBe('rgb(226, 232, 240)');
  });

  it('accepts numeric strings (coerced via Number)', () => {
    expect(getBuyPriceColor('12')).toBe('rgb(251, 191, 36)');
  });
});

describe('toRGBA', () => {
  it('converts an rgb() string to rgba() with the given alpha', () => {
    expect(toRGBA('rgb(15, 192, 216)', 0.5)).toBe('rgba(15, 192, 216, 0.5)');
  });

  it('defaults alpha to 1', () => {
    expect(toRGBA('rgb(0, 0, 0)')).toBe('rgba(0, 0, 0, 1)');
  });

  it('tolerates extra whitespace inside the rgb() string', () => {
    expect(toRGBA('rgb(  10 ,  20 ,  30  )', 0.25)).toBe('rgba(10, 20, 30, 0.25)');
  });

  it('returns the input unchanged when it does not match rgb()', () => {
    expect(toRGBA('#ff0000', 0.5)).toBe('#ff0000');
    expect(toRGBA('rgba(1, 2, 3, 0.5)', 0.5)).toBe('rgba(1, 2, 3, 0.5)');
  });
});

describe('dim', () => {
  it('applies a 0.6 alpha to an rgb color', () => {
    expect(dim('rgb(71, 144, 208)')).toBe('rgba(71, 144, 208, 0.6)');
  });

  it('returns non-rgb input unchanged', () => {
    expect(dim('transparent')).toBe('transparent');
  });
});
