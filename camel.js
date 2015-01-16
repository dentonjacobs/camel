/***************************************************
 * INITIALIZATION                                  *
 ***************************************************/

var express = require('express');
var compress = require('compression');
var http = require('http');
var fs = require('fs');
var qfs = require('q-io/fs');
var sugar = require('sugar');
var _ = require('underscore');
var markdownit = require('markdown-it')({
	html: true,
	xhtmlOut: true,
	typographer: true
}).use(require('markdown-it-footnote'));
var rss = require('rss');
var Handlebars = require('handlebars');
var version = require('./package.json').version;

var app = express();
app.use(compress());
app.use(express.static("public", { redirect: false }));
app.use(function (request, response, next) {
	response.header('X-powered-by', 'Camel (https://github.com/dentonjacobs/camel)');
    next();
})
var server = http.createServer(app);

// "Statics"
var postsRoot = './posts/';
var templateRoot = './templates/';
var metadataMarker = '@@';
var maxCacheSize = 50;
var postsPerPage = 5;
var postRegex = /^(.\\)?posts\\\d{4}\\\d{1,2}\\\d{1,2}\\(\w|-)*(.redirect|.md)?$/; // Windows
//var postRegex = /^(.\/)?posts\/\d{4}\/\d{1,2}\/\d{1,2}\/(\w|-)*(.redirect|.md)?$/; // Not windows
var footnoteAnchorRegex = /[#"]fn\d+/g;
var footnoteIdRegex = /fnref\d+/g;
var utcOffset = 5;
var cacheResetTimeInMillis = 1800000;

var renderedPosts = {};
var renderedRss = {};
var allPostsSortedGrouped = {};
var headerSource = undefined;
var footerSource = null;
var postHeaderTemplate = null;
var postFooterTemplate = null;
var listFooterTemplate = null;
var siteMetadata = {};

/***************************************************
 * HELPER METHODS                                  *
 ***************************************************/

function init() {
    loadHeaderFooter('defaultTags.html', function (data) {
        // Note this comes in as a flat string; split on newlines for parsing metadata.
        siteMetadata = parseMetadata(data.split('\n'));

        // This relies on the above, so nest it.
        loadHeaderFooter('header.html', function (data) {
            headerSource = performMetadataReplacements(siteMetadata, data);
        });
        
        loadHeaderFooter('footer.html', function (data) { 
            footerSource = performMetadataReplacements(siteMetadata, data); 
        });
    });
    loadHeaderFooter('listFooter.html', function (data) {
        Handlebars.registerHelper('formatPostDate', function (date) {
            return new Handlebars.SafeString(new Date(date).format('{yyyy}-{mm}-{dd}, {h}:{mm} {TT}'));
        });
        Handlebars.registerHelper('formatIsoDate', function (date) {
            return new Handlebars.SafeString(date !== undefined ? new Date(date).iso() : '');
        });
        listFooterTemplate = Handlebars.compile(data);
    });
    loadHeaderFooter('postFooter.html', function (data) {
        Handlebars.registerHelper('formatPostDate', function (date) {
            return new Handlebars.SafeString(new Date(date).format('{yyyy}-{mm}-{dd}, {h}:{mm} {TT}'));
        });
        Handlebars.registerHelper('formatIsoDate', function (date) {
            return new Handlebars.SafeString(date !== undefined ? new Date(date).iso() : '');
        });
        postFooterTemplate = Handlebars.compile(data);
    });
    loadHeaderFooter('postHeader.html', function (data) {
        Handlebars.registerHelper('formatPostDate', function (date) {
            return new Handlebars.SafeString(new Date(date).format('{Weekday} {d} {Month} {yyyy}, {h}:{mm} {TT}'));
        });
        Handlebars.registerHelper('formatIsoDate', function (date) {
            return new Handlebars.SafeString(date !== undefined ? new Date(date).iso() : '');
        });
        postHeaderTemplate = Handlebars.compile(data);
    });

    // Kill the cache every 30 minutes.
    setInterval(emptyCache, cacheResetTimeInMillis);

}

function loadHeaderFooter(file, completion) {
    fs.exists(templateRoot + file, function(exists) {
        if (exists) {
            fs.readFile(templateRoot + file, {encoding: 'UTF8'}, function (error, data) {
                if (!error) {
                    completion(data);
                }
            });
        }
    });
}

function normalizedFileName(file) {
    var retVal = file;
    if (file.startsWith('posts')) {
        retVal = './' + file;
    }

    retVal = retVal.replace('.md', '');

    return retVal;
}

function addRenderedPostToCache(file, postData) {
    // console.log('Adding to cache: ' + normalizedFileName(file));
    renderedPosts[normalizedFileName(file)] = _.extend({ file: normalizedFileName(file), date: new Date() }, postData);

    if (_.size(renderedPosts) > maxCacheSize) {
        var sorted = _.sortBy(renderedPosts, function (post) { return post['date']; });
        delete renderedPosts[sorted.first()['file']];
    }

    // console.log('Cache has ' + JSON.stringify(_.keys(renderedPosts)));
}

function fetchFromCache(file) {
    return renderedPosts[normalizedFileName(file)] || null;
}

// Parses the metadata in the file
function parseMetadata(lines) {
    var retVal = {};

    lines.each(function (line) {
        line = line.replace(metadataMarker, '');
        line = line.compact();
        if (line.has('=')) {
            var firstIndex = line.indexOf('=');
            retVal[line.first(firstIndex)] = line.from(firstIndex + 1);
        }
    });

    // NOTE: Some metadata is added in generateHtmlAndMetadataForFile().

    // Merge with site default metadata
    Object.merge(retVal, siteMetadata, false, function(key, targetVal, sourceVal) {
        // Ensure that the file wins over the defaults.
        console.log('overwriting "' + sourceVal + '" with "' + targetVal);
        return targetVal;
    });

    return retVal;
}

function performMetadataReplacements(replacements, haystack) {
    _.keys(replacements).each(function (key) {
        // Ensure that it's a global replacement; non-regex treatment is first-only.
        haystack = haystack.replace(new RegExp(metadataMarker + key + metadataMarker, 'g'), replacements[key]);
    });

    return haystack;
}

// Parses the HTML and renders it.
function parseHtml(lines, replacements, postHeader, postFooter) {
    // Convert from markdown
    var body = performMetadataReplacements(replacements, markdownit.render(lines));
    // Perform replacements
    var header = performMetadataReplacements(replacements, headerSource);
    var footer = performMetadataReplacements(replacements, footerSource);
    // Concatenate HTML
    return header + postHeader + body + postFooter + footer;
}

// Gets all the lines in a post and separates the metadata from the body
function getLinesFromPost(file) {
    file = file.endsWith('.md') ? file : file + '.md';
    var data = fs.readFileSync(file, {encoding: 'UTF8'});

    // Extract the pieces
    var lines = data.lines();
    var metadataLines = _.filter(lines, function (line) { return line.startsWith(metadataMarker); });
    var body = _.difference(lines, metadataLines).join('\n');

    return {metadata: metadataLines, body: body};
}

// Gets the metadata & rendered HTML for this file
function generateHtmlAndMetadataForFile(file) {
    var retVal = fetchFromCache(file);
    if (retVal == undefined) {
        var lines = getLinesFromPost(file);
        var metadata = parseMetadata(lines['metadata']);

        if (metadata['Linked'] == 'Yes'){
            metadata['relativeLink'] =  metadata['Link'];
            metadata['permalink'] = externalFilenameForFile(file);
            metadata['linked'] = 'linked';

        } else {
            metadata['relativeLink'] = externalFilenameForFile(file);
            metadata['permalink'] = metadata['relativeLink'];
            metadata['linked'] = 'notLinked';
        }

        console.log('file: ' +  file + ', title: ' + metadata['title']);
        if (metadata['title'] != '') {
            metadata['title'] = metadata['title'] + ' &mdash; ';
        }

        metadata['header'] = postHeaderTemplate(metadata);
        metadata['footer'] = postFooterTemplate(metadata);
        // If this is a post, assume a body class of 'post'.
        // console.log('file ' + file + ', regex.test: ' + postRegex.test(file));
        if (postRegex.test(file)) {
            metadata['BodyClass'] = 'post';
        }
        var html = parseHtml(lines['body'], metadata, postHeaderTemplate(metadata), postFooterTemplate(metadata));
        addRenderedPostToCache(file, {
            metadata: metadata,
            body: html,
            unwrappedBody: performMetadataReplacements(metadata, generateBodyHtmlForFile(file)) }
        );
    }

    return fetchFromCache(file);
}

// Gets the metadata for this file
function generateMetadataForFile(file) {
    return generateHtmlAndMetadataForFile(file)['metadata'];
}

// Gets the rendered HTML for this file, with header/footer.
function generateHtmlForFile(file) {
    return generateHtmlAndMetadataForFile(file)['body'];
}

// Gets the body HTML for this file, no header/footer.
function generateBodyHtmlForFile(file) {
    var parts = getLinesFromPost(file);
    var body = markdownit.render(parts['body']);
    var metadata = parseMetadata(parts['metadata']);
    metadata['relativeLink'] = externalFilenameForFile(file);
    return body;
}

// Gets the external link for this file. Relative if request is
// not specified. Absolute if request is specified.
function externalFilenameForFile(file, request) {
    var hostname = request != undefined ? request.headers.host : '';

    var retVal = hostname.length ? ('http://' + hostname) : '';
    retVal += file.at(0) == '/' && hostname.length > 0 ? '' : '/';
    retVal += file.replace('.md', '').replace(postsRoot, '').replace(postsRoot.replace('./', ''), '');
    return retVal;
}

// Gets all the posts, grouped by day and sorted descending.
// Completion handler gets called with an array of objects.
// Array
//   +-- Object
//   |     +-- 'date' => Date for these articles
//   |     `-- 'articles' => Array
//   |            +-- (Article Object)
//   |            +-- ...
//   |            `-- (Article Object)
//   + ...
//   |
//   `-- Object
//         +-- 'date' => Date for these articles
//         `-- 'articles' => Array
//                +-- (Article Object)
//                +-- ...
//                `-- (Article Object)
function allPostsSortedAndGrouped(completion) {
    if (Object.size(allPostsSortedGrouped) != 0) {
        completion(allPostsSortedGrouped);
    } else {
        qfs.listTree(postsRoot, function (name, stat) {
            // console.log('list tree name:'  + name + ", regex.test:" + postRegex.test(name));
            return postRegex.test(name);
        }).then(function (files) {
            // console.log('then files: ' + files);
            // Lump the posts together by day
            var groupedFiles = _.groupBy(files, function (file) {
                var parts = file.split('/');
                return new Date(parts[1], parts[2] - 1, parts[3]);
            });

            // Sort the days from newest to oldest
            var retVal = [];
            var sortedKeys = _.sortBy(_.keys(groupedFiles), function (date) {
                return new Date(date);
            }).reverse();

            // For each day...
            _.each(sortedKeys, function (key) {
                // Get all the filenames...
                var articleFiles = groupedFiles[key];
                var articles = [];
                // ...get all the data for that file ...
                _.each(articleFiles, function (file) {
                	if (!file.endsWith('redirect')) {
                    	articles.push(generateHtmlAndMetadataForFile(file));
                    }
                });

                // ...so we can sort the posts...
                articles = _.sortBy(articles, function (article) {
                    // ...by their post date and TIME.
                    return Date.create(article['metadata']['Date']);
                }).reverse();
                // Array of objects; each object's key is the date, value
                // is an array of objects
                // In that array of objects, there is a body & metadata.
                retVal.push({date: key, articles: articles});
            });

            allPostsSortedGrouped = retVal;
            completion(retVal);
        });
    }
}

// Gets all the posts, paginated.
// Goes through the posts, descending date order, and joins
// days together until there are 10 or more posts. Once 10
// posts are hit, that's considered a page.
// Forcing to exactly 10 posts per page seemed artificial, and,
// frankly, harder.
function allPostsPaginated(completion) {
    // console.log('allPostsPaginated -> allPostsSortedAndGrouped');
    allPostsSortedAndGrouped(function (postsByDay) {
        var pages = [];
        var thisPageDays = [];
        var count = 0;
        // console.log('postsByDay: ' + postsByDay);
        postsByDay.each(function (day) {
            count += day['articles'].length;
            thisPageDays.push(day);
            // Reset count if need be
            if (count >= postsPerPage) {
                pages.push({ page: pages.length + 1, days: thisPageDays });
                thisPageDays = [];
                count = 0;
            }
        });

        if (thisPageDays.length > 0) {
            pages.push({ page: pages.length + 1, days: thisPageDays});
        }

        completion(pages);
    });
}

// Empties the caches.
function emptyCache() {
    console.log('Emptying the cache.');
    renderedPosts = {};
    renderedRss = {};
    allPostsSortedGrouped = {};
}

/***************************************************
 * ROUTE HELPERS                                   *
 ***************************************************/

function loadAndSendMarkdownFile(file, response) {
    if (file.endsWith('.md')) {
        // Send the source file as requested.
        fs.exists(file, function (exists) {
            if (exists) {
                fs.readFile(file, {encoding: 'UTF8'}, function (error, data) {
                    if (error) {
                        response.status(500).send({error: error});
                        return;
                    }
                    response.type('text/x-markdown; charset=UTF-8');
                    response.status(200).send(data);
                    return;
                });
            } else {
                response.status(400).send({error: 'Markdown file not found.'});
            }
        });
    } else if (fetchFromCache(file) != null) {
        // Send the cached version.
        console.log('Sending cached file: ' + file);
        response.status(200).send(fetchFromCache(file)['body']);
        return;
    } else {
    	var found = false;
        // Is this a post?
        if (fs.existsSync(file + '.md')) {
			found = true;
			var html = generateHtmlForFile(file);
			response.status(200).send(html);
		// Or is this a redirect?
        } else if (fs.existsSync(file + '.redirect')) {
			var data = fs.readFileSync(file + '.redirect', {encoding: 'UTF8'});
			if (data.length > 0) {
				var parts = data.split('\n');
				if (parts.length >= 2) {
					found = true;
					console.log('Redirecting to: ' + parts[1]);
					response.redirect(parseInt(parts[0]), parts[1]);
				}
			}
        }

        if (!found) {
	        send404(response, file);
        	return;
        }
    }
}

// Sends a listing of an entire year's posts.
function sendYearListing(request, response) {
    var year = request.params.slug;
    var retVal = '<h1>Posts for the year ' + year + '</h1>';
    var currentMonth = null;

    allPostsSortedAndGrouped(function (postsByDay) {
        postsByDay.each(function (day) {
            var thisDay = Date.create(day['date']);
            if (thisDay.is(year)) {
                // Date.isBetween() is not inclusive, so back the from date up one
                var thisMonth = new Date(Number(year), Number(currentMonth)).addDays(-1);
                // ...and advance the to date by two (one to offset above, one to genuinely add).
                var nextMonth = Date.create(thisMonth).addMonths(1).addDays(2);

                //console.log(thisMonth.short() + ' <-- ' + thisDay.short() + ' --> ' + nextMonth.short() + '?   ' + (thisDay.isBetween(thisMonth, nextMonth) ? 'YES' : 'NO'));
                if (currentMonth == null || !thisDay.isBetween(thisMonth, nextMonth)) {
                    // If we've started a month list, end it, because we're on a new month now.
                    if (currentMonth >= 0) {
                        retVal += '</ul>'
                    }

                    currentMonth = thisDay.getMonth();
                    retVal += '<h2><a href="/' + year + '/' + (currentMonth + 1) + '/">' + thisDay.format('{Month}') + '</a></h2>\n<ul>';
                }

                day['articles'].each(function (article) {
                    retVal += '<li><a href="' + externalFilenameForFile(article['file']) + '">' + article['metadata']['Title'] + '</a></li>';
                });
            }
        });

        var header = headerSource.replace(metadataMarker + 'Title' + metadataMarker, 'Posts for ' + year);
        response.status(200).send(header + retVal + footerSource);
    });

}

// Handles a route by trying the cache first.
// file: file to try.
// sender: function to send result to the client. Only parameter is an object that has the key 'body', which is raw HTML
// generator: function to generate the raw HTML. Only parameter is a function that takes a completion handler that takes the raw HTML as its parameter.
// baseRouteHandler() --> generator() to build HTML --> completion() to add to cache and send
function baseRouteHandler(file, sender, generator) {
    if (fetchFromCache(file) == null) {
        console.log('Not in cache: ' + file);
        generator(function (postData) {
            addRenderedPostToCache(file, {body: postData});
            sender({body: postData});
        });
    } else {
        console.log('In cache: ' + file);
        sender(fetchFromCache(file));
    }
}

function send404(response, file) {
	console.log('404: ' + file);
    response.status(404).send(generateHtmlForFile('posts/404.md'));
}

/***************************************************
 * ROUTES                                          *
 ***************************************************/

app.get('/', function (request, response) {
    // Determine which page we're on, and make that the filename
    // so we cache by paginated page.
    var page = 1;
    if (request.query.p != undefined) {
        page = Number(request.query.p);
        if (isNaN(page)) {
            response.redirect('/');
        }
    }

    // Do the standard route handler. Cough up a cached page if possible.
    baseRouteHandler('/?p=' + page, function (cachedData) {
        response.status(200).send(cachedData['body']);
    }, function (completion) {
        var indexInfo = generateHtmlAndMetadataForFile(postsRoot + 'index.md');
        var footnoteIndex = 0;

        Handlebars.registerHelper('formatDate', function (date) {
            return new Handlebars.SafeString(new Date(date).format('{Weekday}<br />{d}<br />{Month}<br />{yyyy}'));
        });
        Handlebars.registerHelper('dateLink', function (date) {
            var parsedDate = new Date(date);
            return '/' + parsedDate.format("{yyyy}") + '/' + parsedDate.format("{M}") + '/' + parsedDate.format('{d}') + '/';
        });
        Handlebars.registerHelper('offsetFootnotes', function (html) {
        	// Each day will call this helper once. We will offset the footnotes
        	// to account for multiple days being on one page. This will avoid
        	// conflicts with footnote numbers. If two days both have footnote,
        	// they would both be "fn1". Which doesn't work; they need to be unique.
        	var retVal = html.replace(footnoteAnchorRegex, '$&' + footnoteIndex);
        	retVal = retVal.replace(footnoteIdRegex, '$&' + footnoteIndex);
        	++footnoteIndex;

        	return retVal;
        });
        Handlebars.registerPartial('article', indexInfo['metadata']['ArticlePartial']);
        var dayTemplate = Handlebars.compile(indexInfo['metadata']['DayTemplate']);
        var footerTemplate = Handlebars.compile(indexInfo['metadata']['FooterTemplate']);

        var bodyHtml = '';
        allPostsPaginated(function (pages) {
            // If we're asking for a page that doesn't exist, redirect.
            if (page < 0 || page > pages.length) {
                var destination = pages.length > 1 ? '/?p=' + pages.length : '/';
                response.redirect(destination);
            }
            var days = pages[page - 1]['days'];
            days.forEach(function (day) {
                bodyHtml += dayTemplate(day);
            });

            // If we have more data to display, set up footer links.
            var footerData = {};
            if (page > 1) {
                footerData['prevPage'] = page - 1;
            }
            if (pages.length > page) {
                footerData['nextPage'] = page + 1;
            }

            var metadata = generateMetadataForFile(postsRoot + 'index.md');
            var header = performMetadataReplacements(metadata, headerSource);
            // Replace <title>...</title> with one-off for homepage, because it doesn't show both Page & Site titles.
            var titleBegin = header.indexOf('<title>') + "<title>".length;
            var titleEnd = header.indexOf('</title>');
            header = header.substring(0, titleBegin) + metadata['SiteTitle'] + header.substring(titleEnd);
            // Carry on with body
            bodyHtml = performMetadataReplacements(metadata, bodyHtml);
            var fullHtml = header + bodyHtml + footerTemplate(footerData) + footerSource;
            completion(fullHtml);
        });
    });
});

app.get('/rss', function (request, response) {
    response.type('application/rss+xml');
    if (renderedRss['date'] == undefined || new Date().getTime() - renderedRss['date'].getTime() > 3600000) {
        var feed = new rss({
            title: siteMetadata['SiteTitle'],
            description: 'Posts to ' + siteMetadata['SiteTitle'],
            feed_url: 'http://www.dentonjacobs.com/rss',
            site_url: 'http://www.dentonjacobs.com',
            author: 'Denton Jacobs',
            webMaster: 'Denton Jacobs',
            copyright: '2012-' + new Date().getFullYear() + ' Denton Jacobs',
            image_url: 'http://www.dentonjacobs.com/images/favicon.png',
            language: 'en',
            //categories: ['Category 1','Category 2','Category 3'],
            pubDate: new Date().toString(),
            ttl: '60'
        });

        var max = 10;
        var i = 0;
        allPostsSortedAndGrouped(function (postsByDay) {
            postsByDay.forEach(function (day) {
                day['articles'].forEach(function (article) {
                    if (i < max) {
                        ++i;
                        feed.item({
                            title: article['metadata']['Title'],
                            // Offset the time because Heroku's servers are GMT, whereas these dates are EST/EDT.
                            date: new Date(article['metadata']['Date']).addHours(utcOffset),
                            url: externalFilenameForFile(article['file'], request),
                            description: article['unwrappedBody'].replace(/<script[\s\S]*?<\/script>/gm, "")
                        });
                    }
                });
            });

            renderedRss = {
                date: new Date(),
                rss: feed.xml()
            };

            response.status(200).send(renderedRss['rss']);
        });
    } else {
        response.status(200).send(renderedRss['rss']);
    }
});

// Month view
app.get('/:year/:month', function (request, response) {
    var path = postsRoot + request.params.year + '/' + request.params.month;

    var postsByDay = {};

    qfs.listTree(path, function (name, stat) {
        return name.endsWith('.md');
    }).then(function (files) {
        _.each(files, function (file) {
            // Gather by day of month
            var metadata = generateHtmlAndMetadataForFile(file)['metadata'];
            var date = Date.create(metadata['Date']);
            var dayOfMonth = date.getDate();
            if (postsByDay[dayOfMonth] == undefined) {
                postsByDay[dayOfMonth] = [];
            }

            postsByDay[dayOfMonth].push({title: metadata['Title'], date: date, url: externalFilenameForFile(file)});
         });

         var html = "";
         // Get the days of the month, reverse ordered.
         var orderedKeys = _.sortBy(Object.keys(postsByDay), function (key) { return parseInt(key); }).reverse();
         // For each day of the month...
         _.each(orderedKeys, function (key) {
             var day = new Date(request.params.year, request.params.month - 1, parseInt(key));
             html += "<h1>" + day.format('{Weekday}, {Month} {d}') + '</h1><ul>';
             _.each(postsByDay[key], function (post) {
                 html += '<li><a href="' + post['url'] + '">' + post['title']  + '</a></li>';
             });
             html += '</ul>';
         });

         var header = headerSource.replace(metadataMarker + 'Title' + metadataMarker, "Day Listing");
         response.status(200).send(header + html + footerSource);
    });
 });

// Day view
app.get('/:year/:month/:day', function (request, response) {
    var path = postsRoot + request.params.year + '/' + request.params.month + '/' + request.params.day;

    // Get all the files in the directory
    fs.readdir(path, function (error, files) {
        if (error) {
            response.status(400).send({error: "This path doesn't exist."});
            return;
        }

        var day = new Date(request.params.year, request.params.month - 1, request.params.day);
        var html = "<h1>Posts from " + day.format('{Weekday}, {Month} {d}') + "</h1><ul>";

        // Get all the data for each file
        var postsToday = [];
        files.each(function (file) {
        	if (postRegex.test(path + '/' + file) && file.endsWith('.md')) {
	            postsToday.push(generateHtmlAndMetadataForFile(path + '/' + file));
	        }
        });

        // Go ahead and sort...
        postsToday = _.sortBy(postsToday, function (post) {
            // ...by their post date and TIME...
            return Date.create(post['metadata']['Date']);
        }); // ...Oldest first.

        postsToday.each(function (post) {
            var title = post['metadata']['Title'];
            html += '<li><a href="' + post['metadata']['relativeLink'] + '">' + post['metadata']['Title'] + '</a></li>';
        });

        var header = headerSource.replace(metadataMarker + 'Title' + metadataMarker, day.format('{Weekday}, {Month} {d}'));
        response.status(200).send(header + html + footerSource);
    })
 });


// Get a blog post, such as /2014/3/17/birthday
app.get('/:year/:month/:day/:slug', function (request, response) {
    var file = postsRoot + request.params.year + '/' + request.params.month + '/' + request.params.day + '/' + request.params.slug;

    loadAndSendMarkdownFile(file, response);
});

// Empties the cache.
app.get('/tosscache', function (request, response) {
    emptyCache();
    response.sendStatus(205);
});

app.get('/count', function (request, response) {
	console.log("/count");
	allPostsSortedAndGrouped(function (all) {
		var count = 0;
		var days = 0;
		for (var day in _.keys(all)) {
			days++;
			count += all[day].articles.length;
		}

		response.send(count + ' articles, across ' + days + ' days that have at least one post.');
	});
});

// Support for non-blog posts, such as /about, as well as years, such as /2014.
app.get('/:slug', function (request, response) {
    // If this is a typical slug, send the file
    if (isNaN(request.params.slug)) {
		var file = postsRoot + request.params.slug;
		loadAndSendMarkdownFile(file, response);
    // If it's a year, handle that.
    } else if (request.params.slug >= 2000) {
        sendYearListing(request, response);
    // If it's garbage (ie, a year less than 2013), send a 404.
    } else {
    	send404(response, request.params.slug);
    }
});

/***************************************************
 * STARTUP                                         *
 ***************************************************/
init();
var port = Number(process.env.PORT || 5000);
server.listen(port, function () {
   console.log('Camel v' + version + ' server started on port %s', server.address().port);
});
