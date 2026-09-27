import { expect, test } from '@playwright/test';

test('a single repository opens straight on its overview', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/r\/1$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/codefossil-fixture-/);
  await expect(page.getByText('Relationships by evidence level')).toBeVisible();
  await expect(page.getByText('Add checkout total')).toBeVisible();
  await expect(page.getByRole('link', { name: /Overview/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('asking why shows the answer, its statements and the evidence each rests on', async ({
  page,
}) => {
  await page.goto('/r/1/investigate');
  await page.getByLabel('Ask about this repository').fill('Why does calculateVAT exist?');
  await page.getByRole('button', { name: 'Investigate' }).click();

  const answer = page.locator('section', { has: page.getByRole('heading', { name: 'Answer' }) });
  await expect(answer).toContainText('Add VAT calculation');

  const statement = page.getByRole('button', { name: /introducing commit/i });
  await statement.click();
  await expect(statement).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/cited for: .*introducing commit/).first()).toBeVisible();

  // Saved investigations are listed and can be reopened as they were.
  const saved = page.getByRole('link', { name: /Why does calculateVAT exist\?/ }).first();
  await saved.click();
  await expect(page).toHaveURL(/show=\d+/);
  await expect(page.getByText(/^Saved /)).toBeVisible();
});

test('an unsupported question explains what can be asked', async ({ page }) => {
  await page.goto('/r/1/investigate?q=make%20me%20a%20sandwich');
  await expect(page.getByLabel('Ask about this repository')).toHaveValue('make me a sandwich');
  await page.getByRole('button', { name: 'Investigate' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'unsupported_question' })).toContainText(
    'why does',
  );
});

test('file search, file history across a rename, and impact', async ({ page }) => {
  await page.goto('/r/1/files');
  await page.getByLabel('Search files by path').fill('tax/vat');
  const link = page.getByRole('link', { name: 'src/tax/vat.ts' });
  await expect(link).toBeVisible();
  await expect(page.getByRole('link', { name: 'src/checkout.ts' })).toBeHidden();
  await link.click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('src/tax/vat.ts');
  await page.getByRole('link', { name: 'History' }).click();
  await expect(page.getByText('src/payment/vat.ts → src/tax/vat.ts')).toBeVisible();
  await expect(page.getByText('Handle reduced VAT rate')).toBeVisible();

  await page.getByRole('link', { name: 'Impact' }).click();
  await expect(page.getByText('src/checkout.ts')).toBeVisible();
});

test('the graph shows relationships and the provenance of a selected one', async ({ page }) => {
  await page.goto('/r/1/graph?root=src%2Ftax%2Fvat.ts&depth=1');
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  expect(await page.locator('.react-flow__edge').count()).toBeGreaterThan(0);

  await page.locator('.react-flow__edge-interaction').first().dispatchEvent('click');
  const provenance = page.locator('aside', { hasText: 'Provenance' });
  await expect(provenance).toContainText('producer');
  await expect(provenance).toContainText('method');
});

test('keyboard shortcuts move between sections and focus search', async ({ page }) => {
  await page.goto('/r/1', { waitUntil: 'networkidle' }); // shortcuts listen once hydrated
  await page.keyboard.press('g');
  await page.keyboard.press('f');
  await expect(page).toHaveURL(/\/r\/1\/files$/);
  await page.keyboard.press('/');
  await expect(page.getByLabel('Search files by path')).toBeFocused();
});

test('the proxy forwards only read routes and investigations', async ({ request }) => {
  const index = await request.post('/api/fossil/repositories/1/index', { data: {} });
  expect(index.status()).toBe(404);
  const files = await request.get('/api/fossil/repositories/1/files?query=vat');
  expect(files.ok()).toBe(true);
});

test('pages refuse requests addressed to another host name', async ({ request }) => {
  const page = await request.get('/r/1', { headers: { host: 'rebound.example:3100' } });
  expect(page.status()).toBe(403);
});

test('hotspots rank files and open to their components', async ({ page }) => {
  await page.goto('/r/1/hotspots');
  const first = page.locator('details').first();
  await expect(first.locator('summary')).toContainText('src/');
  await first.locator('summary').click();
  await expect(first).toContainText('Risk = product of');
  await expect(first).toContainText('untested');

  await page.getByLabel('Order by').selectOption('risk');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/order=risk/);
  await expect(page.getByRole('heading', { name: /Ranked by risk/i })).toBeVisible();
});

test('dead intent lists candidates as inferences with their signals', async ({ page }) => {
  await page.goto('/r/1/dead-intent');
  const candidate = page.getByRole('list', { name: 'Candidates' }).getByRole('listitem').first();
  await expect(candidate).toContainText('calculateVAT');
  await expect(candidate).toContainText('workaround wording');
  await expect(candidate).toContainText('INFERRED');
  await candidate.getByRole('link', { name: /calculateVAT/ }).click();
  await expect(page).toHaveURL(/\/r\/1\/symbols\/\d+$/);
});
