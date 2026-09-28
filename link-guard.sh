#!/bin/sh
LC_ALL=C awk '
function decode(s,    i, c, e, out) {
  out = ""
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (c != "\\") { out = out c; continue }
    e = substr(s, ++i, 1)
    if (e == "n") out = out "\n"; else if (e == "t") out = out "\t"; else if (e == "r") out = out "\r"
    else if (e == "u") { out = out "?"; i += 4 } else if (e == "b" || e == "f") out = out " "; else out = out e
  }
  return out
}
function command(json,    i, j, c, previous, depth, inToolInput, key, raw) {
  depth = 0; previous = ""; inToolInput = 0
  for (i = 1; i <= length(json); i++) {
    c = substr(json, i, 1)
    if (c == "\"") {
      for (j = i + 1; j <= length(json); j++) {
        if (substr(json, j, 1) == "\\") j++
        else if (substr(json, j, 1) == "\"") break
      }
      if (j > length(json)) return ""
      raw = substr(json, i + 1, j - i - 1)
      if ((previous == "{" || previous == ",") && (depth == 1 || (depth == 2 && inToolInput))) key[depth] = decode(raw)
      else if (previous == ":" && depth == 2 && inToolInput && key[2] == "command") return decode(raw)
      i = j; previous = "\""
    } else if (c == "{" || c == "[") {
      if (c == "{" && depth == 1 && previous == ":" && key[1] == "tool_input") inToolInput = 1
      depth++; previous = c
    } else if (c == "}" || c == "]") {
      if (depth == 2) inToolInput = 0
      depth--; previous = c
    } else if (c !~ /^[ \t\r\n]$/) previous = c
  }
  return ""
}
function flush() {
  if (started && waiting) {
    delimiters[++pending] = word; strip[pending] = waitingStrip; waiting = 0
  } else if (word != "") words[++n] = word
  word = ""; started = 0
}
function classify(    i, w, j, c, end, symbolic, targetDirectory, count, first, last, dir) {
  i = 1
  while (i <= n && (words[i] ~ /^(!|\{|then|do|else|elif|if|while|until)$/ || words[i] ~ /^[A-Za-z_][A-Za-z0-9_]*=/)) i++
  if (i > n || (words[i] != "ln" && words[i] !~ /\/ln$/)) return 0
  end = 0; symbolic = 0; targetDirectory = 0; count = 0; first = ""; last = ""
  for (i++; i <= n; i++) {
    w = words[i]
    if (w ~ /^[0-9]*[<>]/) { if (w ~ /^[0-9]*[<>]+$/) i++ }
    else if (!end && w == "--") end = 1
    else if (!end && w ~ /^--./) {
      if (w == "--symbolic") symbolic = 1
      else if (w == "--target-directory" || w ~ /^--target-directory=/) {
        targetDirectory = 1
        if (w == "--target-directory") i++
      } else if (w == "--suffix") i++
    } else if (!end && w ~ /^-./) {
      for (j = 2; j <= length(w); j++) {
        c = substr(w, j, 1)
        if (c == "s") symbolic = 1
        else if (c == "t" || c == "S") {
          if (c == "t") targetDirectory = 1
          if (j == length(w)) i++
          break
        }
      }
    } else {
      count++; if (count == 1) first = w; last = w
    }
  }
  dir = first; sub(/\/+$/, "", dir); sub(/.*\//, "", dir)
  w = last; sub(/\/+$/, "", w); sub(/.*\//, "", w)
  return symbolic && dir == "node_modules" && (targetDirectory || count == 1 || last == "." || last ~ /\/$/ || w == "node_modules")
}
function segment() { flush(); if (n && classify()) found = 1; n = 0 }
function scan(text,    i, c, q, sq, k, start, rest, end, line, closed) {
  sq = sprintf("%c", 39); q = ""; n = 0; word = ""; started = 0; waiting = 0; pending = 0
  for (i = 1; i <= length(text); i++) {
    c = substr(text, i, 1)
    if (q == sq) { if (c == sq) q = ""; else word = word c }
    else if (q == "\"") {
      if (c == "\"") q = ""
      else if (c == "\\" && index("$`\"\\\n", substr(text, i + 1, 1))) word = word substr(text, ++i, 1)
      else word = word c
    }
    else if (c == sq || c == "\"") { q = c; started = 1 }
    else if (c == "<" && substr(text, i + 1, 1) == "<") {
      flush()
      if (substr(text, i + 2, 1) == "<") i += 2
      else { waiting = 1; waitingStrip = substr(text, i + 2, 1) == "-"; i += waitingStrip ? 2 : 1 }
    }
    else if (c == "\\") { c = substr(text, ++i, 1); if (c != "\n") { word = word c; started = 1 } }
    else if (c == "#" && !started) { while (i < length(text) && substr(text, i + 1, 1) != "\n") i++ }
    else if (c == " " || c == "\t") flush()
    else if (c == "\n") {
      segment()
      if (waiting) return
      for (k = 1; k <= pending; k++) {
        closed = 0
        while (i < length(text)) {
          start = i + 1; rest = substr(text, start); end = index(rest, "\n")
          line = end ? substr(rest, 1, end - 1) : rest
          i = end ? start + end - 1 : length(text)
          if (strip[k]) sub(/^\t+/, "", line)
          if (line == delimiters[k]) { closed = 1; break }
        }
        if (!closed) return
      }
      pending = 0
    }
    else if (index(";&|()`", c)) { segment(); if (waiting) return }
    else { word = word c; started = 1 }
  }
  segment()
}
{ json = json $0 "\n" }
END { scan(command(json)); exit found ? 10 : 0 }
'
case $? in
  0) exit 0 ;;
  10) printf '%s\n' "$1" >&2; exit 2 ;;
  *) echo "link-guard: check failed; command allowed" >&2; exit 1 ;;
esac
