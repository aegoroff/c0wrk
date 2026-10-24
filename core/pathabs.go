package core

import (
	"regexp"
	"strings"
)

// absolutePathRe matches a path that is absolute in a GOOS-independent sense
// (mirroring isAbsolutePath in frontend/src/lib/localFileLink.ts):
//   - POSIX: a leading "/" ("/abs/path/x.go");
//   - Windows drive-rooted: ^[A-Za-z]:[\\/] ("C:\x", "d:/y") — the required
//     separator keeps the drive-relative "C:x" relative;
//   - Windows UNC: ^[\\/]{2} ("\\server\share\x").
var absolutePathRe = regexp.MustCompile(`^(?:/|[A-Za-z]:[\\/]|[\\/]{2})`)

// IsAbsolutePath reports whether p is an absolute path in any dialect an
// @file reference may carry: POSIX leading "/", Windows drive-rooted
// ("C:\…"), or Windows UNC ("\\server\…"). The check is purely lexical — no
// filesystem access and no OS dependency — so the same text classifies the
// same way on every platform, which is what the fileref:// URI contract
// needs: the URI is a logical identifier, not an OS path. Home-relative
// paths ("~/…") are intentionally not absolute here; the resolver treats
// them as their own category.
func IsAbsolutePath(p string) bool {
	return absolutePathRe.MatchString(p)
}

// NormalizeAbsPath returns the canonical forward-slash form of an absolute
// path for use as the path component of a fileref:// URI. Every backslash
// becomes a forward slash and dot segments are removed, with ".." clamped at
// the path's anchored root so it can never rise above the filesystem root,
// the drive root, or the UNC share. Canonical output forms:
//
//	POSIX: /a/b/c
//	drive: C:/a/b/c               (no leading slash before the drive letter)
//	UNC:   //server/share/a/b     (the double-slash prefix is preserved)
//
// The semantics mirror normalizeAbsolute in frontend/src/lib/localFileLink.ts,
// which consumes these URI paths. The ".." clamp is deliberate: a plain
// path.Clean would pop across the anchor ("C:\..\x" → "../x", erasing the
// drive) and collapse the UNC "//" marker into a single slash.
func NormalizeAbsPath(p string) string {
	s := strings.ReplaceAll(p, "\\", "/")
	switch {
	case strings.HasPrefix(s, "//"):
		// UNC: the first two segments (server, share) are pinned.
		return "//" + cleanAbsSegments(s[2:], 2)
	case len(s) >= 2 && s[1] == ':' && isDriveLetterByte(s[0]):
		// Drive-rooted: the "X:" prefix is the anchor; the canonical form
		// has exactly one "/" after the colon.
		return s[:2] + "/" + cleanAbsSegments(s[2:], 0)
	case strings.HasPrefix(s, "/"):
		// POSIX: the leading slash is the anchor.
		return "/" + cleanAbsSegments(s[1:], 0)
	}
	// Not absolute — clean as far as a relative path allows. NormalizeAbsPath
	// is intended for absolute inputs (IsAbsolutePath), so this fallback only
	// keeps the function total for direct callers.
	return cleanAbsSegments(s, 0)
}

// isDriveLetterByte reports whether b is an ASCII letter — the drive byte of
// a Windows drive-rooted path.
func isDriveLetterByte(b byte) bool {
	return b >= 'A' && b <= 'Z' || b >= 'a' && b <= 'z'
}

// cleanAbsSegments removes empty and "." segments and resolves ".." against
// the remaining ones, never popping below floor segments — the anchored root
// (filesystem root, drive root, or UNC server/share pair). It mirrors
// normalizeSegments in frontend/src/lib/localFileLink.ts.
func cleanAbsSegments(tail string, floor int) string {
	parts := strings.Split(tail, "/")
	segs := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part {
		case "", ".":
			// Drop empty and current-dir segments.
		case "..":
			if len(segs) > floor {
				segs = segs[:len(segs)-1]
			}
		default:
			segs = append(segs, part)
		}
	}
	return strings.Join(segs, "/")
}
