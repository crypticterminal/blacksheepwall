#!/usr/bin/env node
// Copyright (c) 2012 Tom Steele, Jason Doyle
// See the file license.txt for copying permission
var fs = require('fs');
var https = require('https');
var dns = require('dns');
var program = require('commander');
var async = require('async');
var bsw = require('../lib/blacksheepwall');
var _ = require('underscore');
var netmask = require('netmask');

program
  .version('0.0.3')
  .usage('[options] <ip range>')
  .option('-c, --concurrency <int>', 'limit amount of asynchronous requests')
  .option('-d, --dictionary <file>', 'hostname guessing using a one host per line dictionary')
  .option('-t, --target <domain>', 'domain to use')
  .option('-r, --reverse', 'reverse name lookup')
  .option('-s, --ssl', 'grab names from ssl certificates')
  .option('-b, --bing', 'search bing for vhosts')
  .option('-k, --bingkey <apikey>', 'supply api key for bing searches')
  .option('-w, --web', 'grab names from DNS websites (currently only robtex.com)')
  .option('-f, --fcrdns', 'perform forward confirmed rDNS on all names')
  .option('--headers', 'parse http and https response headers for hostnames')
  .option('-i, --input <file>', 'input file containing ip addresses')
  .option('--csv', 'output to csv')
  .option('--clean', 'ouput clean data')
  .option('--json', 'output a json object')
  .parse(process.argv);

if (program.target && !program.dictionary) {
  croak('--target is used for --dictionary attacks');
}

if (!program.args[0] && !program.dictionary && !program.input) {
  croak('no ip range or dictionary provided');
}

// concurrency gets set to 1000, that's healthy, but you could probably increase the amount
var concurrency = program.concurrency ? program.concurrency : 1000;
var ips = [];

// generate a list of ips from input
if (program.args[0]) {
  var block = new netmask.Netmask(program.args[0]);
  var start = netmask.ip2long(block.first);
  var end = netmask.ip2long(block.last);
  while (start <= end) {
    ips.push(netmask.long2ip(start));
    start++;
  }
  if (program.input) {
   console.log('[!] ignoring input file');
  }
}

if (program.input && !program.args[0]) {
  if (!fs.existsSync(program.input)) {
    croak('Invalid input file location');
  }
  var ips = fs.readFileSync(program.input, {encoding: 'utf8'}).trimRight().split("\n");
  // on windows we need to remove the '\r' 
  ips = ips.map(function(x) { return x.trimRight() });
}

var tasks = [];

if (program.dictionary) {
  if (!program.target) {
    croak('dictionary attack requires target domain');
  }
  tasks.push(function(callback) {
    dns.resolve4('youmustconstructadditionalpylons.' + program.target, function (err, addresses) {
      if (addresses) {
        console.log('skipping dictionary lookups for wildcard domain *.' + program.target);
      }
      else {
        doDictionary();
      }
    });

    function doDictionary() {
      var items = fs.readFileSync(program.dictionary, {encoding: 'utf8'}).trimRight().split("\n");
      items = items.map(function(x) { return x.trimRight() });
      bsw.dictionary(program.target, items, concurrency, function(results) {
        callback(null, results);
      });
    }
  });
}

if (program.reverse) {
  tasks.push(function(callback) { 
    bsw.reverse(ips, concurrency, function(results) {
      callback(null, results);
    });
  });
}

if (program.ssl) {
  tasks.push(function(callback) {
    bsw.cert(ips, concurrency, function(results) {
      callback(null, results);
    });
  });
}

if (program.bing) {
  if (program.bingkey) {
    tasks.push(function(callback) {
      var apiPaths = ['/Data.ashx/Bing/Search/v1/Web',
                      '/Data.ashx/Bing/SearchWeb/v1/Web'];
      apiDetect(apiPaths);

      function apiDetect(apiPaths) {
        var options = {
          host: 'api.datamarket.azure.com',
          auth: program.bingkey + ':' + program.bingkey
        };
        options.path = apiPaths[0] + "?Query=%27I<3BSW%27";
        if (!apiPaths.length) {
          croak("invalid bing api key");
        }
        https.get(options, function(res) {
          if (res.statusCode === 200) {
             doBing(options);
          }
          else {
            apiPaths.shift();
            apiDetect(apiPaths);
          }
        });
      }

      function doBing(options) {
        bsw.bingApi(ips, concurrency, options, function(results) {
          callback(null, results);
        });
      }
    });
  }

  else {
    console.error('no bing api key provided, good luck!');
    tasks.push(function(callback) {
      bsw.bing(ips, concurrency, function(results) {
        callback(null, results);
      });
    });
  }
}

if (program.web) {
  tasks.push(function(callback) {
    bsw.robtex(ips, concurrency, function(results) {
      callback(null, results);
    });
  });
}

if (program.headers) {
  tasks.push(function(callback) {
    bsw.headers(ips, concurrency, function(results) {
      callback(null, results);
    });
  });
}

var now = new Date();
console.error('bsw started at', now);

async.parallel(tasks, function(err, results) {
  if (err) {
    console.log(err);
  }
  else {
    var now = new Date();
    console.error('bsw finished at', now);
    results = _.flatten(results);
    if (program.fcrdns && results.length) {
      bsw.fcrdns(results, concurrency, function(cleanResults) {
        output(cleanResults);
      });
    }
    else {
      output(results);
    }
  }
});

// output
function output(results)  {
  var sorted = {};
  
  if (program.csv) { 
    outcsv(results);
  }

  else if (program.clean) {
    sort();
    outclean(sorted);
  }
    
  else if (program.json) {
    sort();
    outjson(sorted);
  }

  else {
    results.forEach(function(record) {
      if (record.ip) {
        console.log('name:', record.name, 'ip:', record.ip, 'method:', record.src);
      }
    });
  }
  process.exit(0);

  function sort() {
    results.forEach(function(record) {
      // when we flatten the arrays they well leave an empty object if no results
      if (record.ip) {
        if (sorted[record.ip]) {
          sorted[record.ip].push(record.name);
        }
        else {
          sorted[record.ip] = [record.name];
        }
      }
    });
    for (var k in sorted) {
      sorted[k] = _.uniq(sorted[k]);
    }
  }
}

function outcsv(results) {
  results.forEach(function(record) {
    if (record.ip) {
      console.log(record.name + ',' +  record.ip + ',' + record.src);
    }
  });
}

function outjson(sorted) {
  var jsonout= [];
  for (var k in sorted) {
    jsonout.push({ "ip": k, "names": sorted[k] });   
  }
  console.log(JSON.stringify(jsonout, null, " "));
}

function outclean(sorted) {
  for (var k in sorted) {
    console.log(k + ':');
    sorted[k].forEach(function(element) {
      console.log('   ', element);
    });
  }
}

//
// generic function to print and exit
//
function croak(errorMessage) {
  console.log(errorMessage);
  process.exit(1);
}
