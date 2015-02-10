@@ Title=dentonjacobs.com
@@ BodyClass=homepage
<<<<<<< HEAD
@@ DayTemplate=<div class="day"><div class="articles">{{#each articles}}{{> article}}{{/each}}</div></div>
@@ ArticlePartial=<div class="article primaryParagraph">{{{metadata.header}}}{{{offsetFootnotes unwrappedBody}}}{{{metadata.footer}}}<hr /></div>
=======
@@ DayTemplate=<div class="day"><div class="articles">{{#each articles}}{{> article}}{{/each}}</div><hr class="daybreak" /></div>
@@ ArticlePartial=<div class="article">{{{postHeader}}}{{{offsetFootnotes unwrappedBody}}}</div>
>>>>>>> upstream/master
@@ FooterTemplate=<div class="paginationFooter">{{#if prevPage}}<a href="/?p={{prevPage}}" class="previousPage">&laquo; Newer</a>{{/if}}{{#if nextPage}}<a href="/?p={{nextPage}}" class="nextPage">&raquo; Older</a>{{/if}}</div>
