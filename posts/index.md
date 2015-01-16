@@ Title=dentonjacobs.com
@@ BodyClass=homepage
@@ DayTemplate=<div class="day"><div class="articles">{{#each articles}}{{> article}}{{/each}}</div></div>
@@ ArticlePartial=<div class="article primaryParagraph">{{{metadata.header}}}{{{offsetFootnotes unwrappedBody}}}{{{metadata.footer}}}<hr /></div>
@@ FooterTemplate=<div class="paginationFooter">{{#if prevPage}}<a href="/?p={{prevPage}}" class="previousPage">&laquo; Newer</a>{{/if}}{{#if nextPage}}<a href="/?p={{nextPage}}" class="nextPage">&raquo; Older</a>{{/if}}</div>
