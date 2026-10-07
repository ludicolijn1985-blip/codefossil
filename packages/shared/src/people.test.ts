import { describe, expect, it } from 'vitest';
import { People } from './people.js';

const commit = (authorName: string, authorEmail: string, committedAt: string) => ({
  authorName,
  authorEmail,
  committedAt,
});

describe('People', () => {
  it('joins name spellings and shared email addresses, shown under the latest name', () => {
    const people = new People([
      commit('Tj Holowaychuk', 'tj@example.com', '2010-01-01T00:00:00Z'),
      commit('visionmedia', 'tj@example.com', '2011-01-01T00:00:00Z'),
      commit('TJ  Holowaychuk', 'other@example.com', '2012-01-01T00:00:00Z'),
      commit('Doug', 'doug@example.com', '2020-01-01T00:00:00Z'),
    ]);
    expect(people.personOf({ authorName: 'visionmedia' })).toBe('TJ  Holowaychuk');
    expect(people.personOf({ authorName: 'tj holowaychuk' })).toBe('TJ  Holowaychuk');
    expect(people.lastCommitOf('TJ  Holowaychuk')).toBe('2012-01-01T00:00:00Z');
    expect(people.asOf).toBe('2020-01-01T00:00:00Z');
  });

  it('does not join people through anonymous email addresses', () => {
    const people = new People([
      commit('Ada', 'noreply@github.com', '2020-01-01T00:00:00Z'),
      commit('Bob', 'noreply@github.com', '2020-01-02T00:00:00Z'),
    ]);
    expect(people.personOf({ authorName: 'Ada' })).toBe('Ada');
    expect(people.personOf({ authorName: 'Bob' })).toBe('Bob');
  });

  it('measures activity back from the latest commit, not from today', () => {
    const people = new People([
      commit('Old', 'old@example.com', '2015-01-01T00:00:00Z'),
      commit('Recent', 'recent@example.com', '2016-06-01T00:00:00Z'),
      commit('Latest', 'latest@example.com', '2017-01-01T00:00:00Z'),
    ]);
    expect(people.isActive('Latest')).toBe(true);
    expect(people.isActive('Recent')).toBe(true);
    expect(people.isActive('Old')).toBe(false);
    expect(people.isActive('Nobody')).toBe(false);
    expect(new People([]).asOf).toBeNull();
  });
});
