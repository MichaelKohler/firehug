'use strict';

// setup
var fs = require( 'fs' );
var later = require( 'later' );
var fork = require( 'child_process' ).fork;
var shared = require( '../shared' );
var env = shared.env;
var debug = shared.debug;

// get scripts in ./bin to run
var bins = {};

// get all files in the same dir as this
fs.readdirSync( __dirname ).filter( function( file ) {
  // filter out dotfiles, and this file
  return ( ( file.indexOf( '.' ) !== 0 ) && ( file !== 'index.js' ) );
}).forEach( function( file ) {
  // for each create an object for it in `bins`
  bins[ file.split( '.' )[ 0 ] ] = {
    path: __dirname + '/' + file,
    status: 'idle',
    ref: null
  };
});

/**
 * Fork all bins
 */
function forkBins() {
  Object.keys( bins ).forEach( function( bin ) {
    if( bins[ bin ].status !== 'running' ) {
      debug( 'Job: %s forked', bin );

      // fork process
      bins[ bin ].ref = fork( bins[ bin ].path );
      bins[ bin ].status = 'running';

      // deal w/ process end
      bins[ bin ].ref.on( 'exit', function( code, signal ) {
        // note end of process
        bins[ bin ].ref = null;
        bins[ bin ].status = 'idle';

        // if exit code != 0 set status to "failing"
        if( code !== 0 ) {
          bins[ bin ].status = 'crashed';
        }

        debug( 'Job: %s exited w/ code %d - signal %d', bin, code, signal );
      });
    }
    else {
      bins[ bin ].status = 'timeout';
      bins[ bin ].ref.kill();
      bins[ bin ].ref = null;
    }
  });
}
// run immediately on load
forkBins();

var schedule = later.parse.cron( env.get( 'JOB_SCHEDULE' ) );
later.setInterval( forkBins, schedule );

module.exports = {
  getStatus: function() {
    var rtn = {};
    Object.keys( bins ).forEach( function( bin ) {
      rtn[ bin ] = bins[ bin ].status;
    });

    return rtn;
  }
};
