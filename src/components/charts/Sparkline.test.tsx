import { describe, it, expect, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeProvider } from '../../context/ThemeContext';
import { Sparkline } from './Sparkline';

afterEach(() => {
  localStorage.removeItem('theme-motion');
});

function renderSparkline(points: number[], height?: number) {
  return render(
    <ThemeProvider>
      <Sparkline points={points} height={height} data-testid="spark" />
    </ThemeProvider>
  );
}

describe('Sparkline', () => {
  it('renders an svg with a line path whose d starts with M', () => {
    const { getByTestId } = renderSparkline([1, 5, 3, 8, 2, 9]);
    const svg = getByTestId('spark');
    expect(svg.tagName.toLowerCase()).toBe('svg');
    const line = svg.querySelector('[data-testid="sparkline-line"]');
    expect(line).toBeTruthy();
    expect(line!.getAttribute('d')).toMatch(/^M/);
  });

  it('draws a straight mid-line (no NaN) when there are fewer than 2 points', () => {
    const { getByTestId } = renderSparkline([42], 36);
    const line = getByTestId('spark').querySelector('[data-testid="sparkline-line"]')!;
    const d = line.getAttribute('d')!;
    expect(d).not.toMatch(/NaN/);
    expect(d).toBe('M0,18 L100,18');
  });

  it('draws a straight mid-line (no NaN) when the range is flat', () => {
    const { getByTestId } = renderSparkline([7, 7, 7, 7], 36);
    const line = getByTestId('spark').querySelector('[data-testid="sparkline-line"]')!;
    const d = line.getAttribute('d')!;
    expect(d).not.toMatch(/NaN/);
    expect(d).toBe('M0,18 L100,18');
  });

  it('normalizes a varying series across the full width and height with no NaN', () => {
    const { getByTestId } = renderSparkline([0, 10, 5, 20, 1]);
    const line = getByTestId('spark').querySelector('[data-testid="sparkline-line"]')!;
    const d = line.getAttribute('d')!;
    expect(d).not.toMatch(/NaN/);
    // 5 points -> "M0,y0 L25,y1 L50,y2 L75,y3 L100,y4"
    expect(d.split(' ')).toHaveLength(5);
  });

  it('applies the chart-draw class for the entrance animation when motion is not reduced', () => {
    const { getByTestId } = renderSparkline([1, 2, 3]);
    const line = getByTestId('spark').querySelector('[data-testid="sparkline-line"]')!;
    expect(line.getAttribute('class')).toContain('chart-draw');
  });

  it('skips the chart-draw class when reduced motion is on', () => {
    localStorage.setItem('theme-motion', 'reduced');
    const { getByTestId } = renderSparkline([1, 2, 3]);
    const line = getByTestId('spark').querySelector('[data-testid="sparkline-line"]')!;
    expect(line.getAttribute('class')).not.toContain('chart-draw');
  });

  it('uses unique gradient ids across two instances on the same page', () => {
    render(
      <ThemeProvider>
        <Sparkline points={[1, 2, 3]} data-testid="a" />
        <Sparkline points={[3, 2, 1]} data-testid="b" />
      </ThemeProvider>
    );
    const gradA = document.querySelectorAll('[data-testid="a"] linearGradient')[0];
    const gradB = document.querySelectorAll('[data-testid="b"] linearGradient')[0];
    expect(gradA.id).not.toBe(gradB.id);
  });
});
