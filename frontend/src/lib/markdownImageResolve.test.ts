import { describe, it, expect } from 'vitest'
import { EXTERNAL_SRC_RE, normalizeAbsolutePath, candidateImagePaths } from './markdownImageResolve'

describe('normalizeAbsolutePath', () => {
  it('collapses "." and ".." segments', () => {
    expect(normalizeAbsolutePath('/a/b/./c/../d')).toBe('/a/b/d')
  })

  it('treats ".." above root as root', () => {
    expect(normalizeAbsolutePath('/a/../../b')).toBe('/b')
  })

  it('keeps already-clean absolute paths', () => {
    expect(normalizeAbsolutePath('/repo/docs/img.png')).toBe('/repo/docs/img.png')
  })
})

describe('candidateImagePaths', () => {
  it('returns the path verbatim for absolute src', () => {
    expect(candidateImagePaths('/abs/img.png', '/repo/readme.md', '/repo')).toEqual(['/abs/img.png'])
  })

  it('resolves relative to the document directory first, then the workspace root', () => {
    expect(candidateImagePaths('assets/a.png', '/repo/docs/readme.md', '/repo')).toEqual([
      '/repo/docs/assets/a.png',
      '/repo/assets/a.png',
    ])
  })

  it('omits the document-relative candidate when the document has no directory', () => {
    expect(candidateImagePaths('a.png', 'readme.md', '/repo')).toEqual([
      '/repo/a.png',
    ])
  })

  it('falls back to the workspace root only when no document path is given', () => {
    expect(candidateImagePaths('docs/a.png', null, '/repo')).toEqual(['/repo/docs/a.png'])
  })

  it('returns an empty array when neither base nor root is available', () => {
    expect(candidateImagePaths('a.png', null, null)).toEqual([])
  })
})

describe('normalizeAbsolutePath (windows)', () => {
  it('preserves the drive prefix and forward-slashes backslashes', () => {
    expect(normalizeAbsolutePath('C:\\img\\p.png')).toBe('C:/img/p.png')
    expect(normalizeAbsolutePath('C:/img/p.png')).toBe('C:/img/p.png')
  })

  it('clamps ".." at the drive root', () => {
    expect(normalizeAbsolutePath('C:\\ws\\..\\x')).toBe('C:/x')
  })

  it('preserves the UNC share root', () => {
    expect(normalizeAbsolutePath('\\\\srv\\share\\img.png')).toBe('//srv/share/img.png')
  })
})

describe('candidateImagePaths (windows)', () => {
  it('returns the drive path alone for a drive-rooted src, ignoring base and root', () => {
    expect(candidateImagePaths('C:\\img\\p.png', '/repo/readme.md', '/repo')).toEqual(['C:/img/p.png'])
  })

  it('resolves a relative src against windows document and root paths', () => {
    expect(candidateImagePaths('img.png', 'C:\\ws\\docs\\readme.md', 'C:\\ws')).toEqual([
      'C:/ws/docs/img.png',
      'C:/ws/img.png',
    ])
  })
})

describe('EXTERNAL_SRC_RE', () => {
  it('treats windows drive srcs as local paths, never as external URLs', () => {
    expect(EXTERNAL_SRC_RE.test('C:\\img\\p.png')).toBe(false)
    expect(EXTERNAL_SRC_RE.test('C:/img/p.png')).toBe(false)
    expect(EXTERNAL_SRC_RE.test('c:img.png')).toBe(false)
  })

  it('still matches data URLs and real (two-plus character) schemes', () => {
    expect(EXTERNAL_SRC_RE.test('data:image/png;base64,AAAA')).toBe(true)
    expect(EXTERNAL_SRC_RE.test('https://example.com/a.png')).toBe(true)
    expect(EXTERNAL_SRC_RE.test('ab:two-letter-scheme')).toBe(true)
  })
})
