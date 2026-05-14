function removeYouTubeTags(text) {
  if (!text) return text;
  return text.replace(/\[youtube\][\s\S]*?\[\/youtube\]/gi, '').replace(/\s{2,}/g, ' ').trim();
}

// Ejemplo:
const descr = "Texto antes [youtube]https://www.youtube.com/watch?v=ps9-n6rnniQ[/youtube] texto después";
console.log(removeYouTubeTags(descr));
