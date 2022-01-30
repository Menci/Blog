hexo.extend.filter.register("post_permalink", link => {
  while (link.startsWith("/")) link = link.slice(1);
  if (!link.endsWith("/")) link += "/";
  return link;
});
