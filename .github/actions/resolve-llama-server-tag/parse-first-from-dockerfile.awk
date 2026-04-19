# First non-comment FROM line → first image ref (optional --flags, optional AS … stripped).
# Keep in sync with test/integration/dockerfile-from-image.ts (FROM_IMAGE_REGEX).

/^[[:space:]]*#/ {
	next
}
/^[[:space:]]*FROM[[:space:]]/ {
	line = $0
	sub(/^[[:space:]]*[Ff][Rr][Oo][Mm][[:space:]]+/, "", line)
	sub(/[[:space:]]+[Aa][Ss][[:space:]].*$/, "", line)
	while (match(line, /^[[:space:]]*--[a-zA-Z0-9_-]+(=[^[:space:]]+)?[[:space:]]+/)) {
		line = substr(line, RSTART + RLENGTH)
	}
	gsub(/^[[:space:]]+/, "", line)
	match(line, /^[^[:space:]]+/)
	if (RSTART > 0) {
		print substr(line, RSTART, RLENGTH)
	}
	exit
}
