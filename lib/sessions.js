'use strict';

var moment = require( 'moment-timezone' );
var lodash = require( 'lodash' );
var marked = require( 'marked' );
var remoteConfig = require( './remoteConfig' );
var shared = require( '../shared' );
var redisClient = shared.redisClient;
var env = shared.env;
var debug = shared.debug;

var redisPrefix = env.get( 'REDIS_PREFIX' ) || 'firehug';
redisPrefix = redisPrefix + ':sheets';

/**
 * Gets a theme's name, and descripion using its slug
 *
 * @param  {String} theme Theme's slug
 * @return {Object}       Object containing the theme's name, slug, and description
 */
function getTheme( theme ) {
  var themeDetails = remoteConfig.getKey( theme ) || {};
  return {
    slug: theme,
    name: themeDetails.theme,
    description: themeDetails.description
  };
}

/**
 * Get an array of theme slugs
 *
 * @return {Array} An array of theme slugs (strings)
 */
function getThemeSlugs() {
  var themes = remoteConfig.getType( 'theme' );
  var rtn = [];
  for( var slug in themes ) {
    rtn.push( slug );
  }
  return rtn;
}

/**
 * Get all themes and their names
 *
 * @return {Array} An array of objects conating theme names and descriptions
 */
function getThemes() {
  var themes = [];
  var themeNames = remoteConfig.getType( 'theme' );

  for( var slug in themeNames ) {
    themes.push({
      slug: slug,
      name: themeNames[ slug ],
      description: remoteConfig.get( slug + ':description' )
    });
  }

  return themes;
}

/**
 * Returns public view of twitter handle for a facilitator
 * based on session privacy options
 *
 * @param  {String} handle          Twitter handle
 * @param  {String} privacyOptions  Privacy options
 * @return {String}                 Publicly safe string
 */
// function facilitatorTwitter( handle, privacyOptions ) {
//   // check if we should hide the handle
//   if( /twitter/ig.test( privacyOptions ) ) {
//     return '';
//   }

//   return handle;
// }

/**
 * Return an array of facilitators for a session [internal]
 *
 * @param  {Object} session A session object
 * @return {Array}          Array of facilitators for public display
 */
function sessionFaclitiators( rawFacilitators ) {
  var facilitators = [];

  if( !rawFacilitators ) {
    return;
  }

  rawFacilitators.split( '\n' ).forEach( function( facilitator ) {
    var twitterRegExp = /\B@[a-z0-9_-]+/ig; // matches a twitter handle

    // look for their twitter handle and separate that out from their name
    // var twitter = facilitator.match( twitterRegExp ) || '';
    // if( twitter ) {
    //   twitter = facilitatorTwitter( twitter[ 0 ], session.privacy );
    // }

    // clean up their name to be just that
    facilitator = facilitator.replace( twitterRegExp, '' ).trim();

    // add results if we have a name OR twitter handle
    if( facilitator /*|| twitter*/ ) {
      facilitators.push({
        name: facilitator,
        // twitter: twitter
      });
    }
  });

  return facilitators;
}

/**
 * Returns public view of orgnaization/affilliation based on
 * session privacy options
 *
 * @param  {String} organization   The organization/affliation
 * @param  {String} privacyOptions Privacy options
 * @return {String}                Publicly safe string
 */
// function sessionOrganization( organization, privacyOptions ) {
//   // check if we should hide orgnaization/affilliation
//   if( /orgnaization/ig.test( privacyOptions ) ) {
//     return '';
//   }

//   return organization;
// }

/**
 * Clean a session for public display [internal]
 *
 * @param  {Object} session A session object
 * @return {Object}         Cleaned session object
 */
function cleanSession( session ) {
  var themeName = getTheme( session.theme ) || { name: '' };
  themeName = themeName.name;

  // determine columns to not show
  Object.keys( session ).forEach( function( key ) {
    if( /^noshow(.+)/i.test( key ) ) {
      delete session[ key ];
    }
  });

  // determine if column should be parsed as markdown
  Object.keys( session ).forEach( function( key ) {
    if( /^mdify(.+)/i.test( key ) ) {
      // parse content as markdown
      var content = marked( session[ key ] );
      // delete old entry from object
      delete session[ key ];
      // inject in w/o "mdify" at start of key
      key = key.replace( /^mdify/i, '' );
      session[ key ] = content;
    }
  });

  // split tags into an array
  if( session.tags && session.tags.trim() ) {
    session.tags = session.tags.trim().split( /[,#]\s?/ig );
    session.tags.forEach( function( tag, idx ) {
      session.tags[ idx ] = tag.trim();
    });
    session.tags = session.tags.filter( function( tag ) {
      return ( tag.trim() && tag.trim() !== '#' );
    });
  }
  else {
    session.tags = [];
  }

  // return clean session
  return lodash.extend( session, {
    id: session.sid, // do not expose Google defined ID, use "sid"
    sid: undefined, // remove "sid" as a seperate field
    title: session.title,
    description: session.description || session.goals.substr( 0, 300 ) + '...', // if no description use excerpt from goals
    theme: themeName,
    themeSlug: session.theme,
    facilitators: sessionFaclitiators( session.facilitators ),
    date: undefined, // don't need this seperate to start + end
    start: moment.tz( session.date + ' ' + session.start, 'DD-MM-YYYY HH:mm', env.get( 'EVENT_TIMEZONE' ) ).format(),
    end: moment.tz( session.date + ' ' + session.end, 'DD-MM-YYYY HH:mm', env.get( 'EVENT_TIMEZONE' ) ).format()
  });
}

/**
 * Get sessions to publicly display
 *
 * @param  {[String]} theme A theme to refine results to (optional)
 * @param  {Function} done  Callback function given an `Error` and `Array` param
 */
function getSessions( theme, done ) {

  // make theme optional
  if( typeof theme === 'function' ) {
    done = theme;
    theme = undefined;
  }

  /**
   * Processes sessions so that they are safe for public consumption,
   * and conform to the format required for the API
   *
   * @param  {Error} err      Error object from redisClient if encountered, else `undefined`
   * @param  {Array} sessions Array of sessions
   */
  function processSessions( err, sessions ) {
    if( err ) {
      done( err, [] );
      return console.error( err );
    }

    if( sessions === null ) {
      done( err, [] );
      return debug( 'no sessions found' );
    }

    var rawSessions = JSON.parse( sessions ).data;
    sessions = []; // repurpose sessions to recieve cleaned up data

    // enforce required fields for processing
    rawSessions = rawSessions.filter( function( session ) {
      if( ( session.title ) &&
          ( session.date && session.start && session.end ) &&
          ( session.description || session.goals ) ) {
        return true;
      }
      return false;
    });

    // clean sessions up for api
    rawSessions.forEach( function( session ) {
      // only return session if its of the correct theme
      if( theme ) {
        session.theme = theme;
      }

      // clean up the session ready for public output
      // then pump into return
      sessions.push( cleanSession( session ) );
    });

    // sort sessions on start time then end time
    sessions.sort( function( a, b ) {
      // sort on start time (a < b)
      if( moment( a.start ).isBefore( b.start ) ) {
        return -1;
      }

      // sort on start time (a > b )
      if( moment( a.start ).isAfter( b.start ) ) {
        return 1;
      }

      // sort on end time (a < b)
      if( moment( a.end ).isBefore( b.end ) ) {
        return -1;
      }

      // sort on end time (a > b)
      if( moment( a.end ).isAfter( b.end ) ) {
        return 1;
      }

      // both start and end times for a and b are the same
      return 0;
    });

    done( err, sessions );
  }

  // if theme provided simple `redisClient.get()` for sessions
  if( theme && getThemeSlugs().indexOf( theme ) > -1 ) {
    return redisClient.get( redisPrefix + ':' + theme, processSessions );
  }
  else if( !theme ) {
    /*
      Theme was not given, so we have to get them all
     */
    var themeNames = getThemeSlugs();
    themeNames.forEach( function( theme, index ) {
      themeNames[ index ] = redisPrefix + ':' + theme;
    });

    return redisClient.mget( themeNames, function( err, allSessions ) {
      var sessionData = { data: [] };

      allSessions.forEach( function( sessions ) {
        if( sessions === null ) {
          return;
        }

        sessions = JSON.parse( sessions );
        sessions.data.forEach( function( session ) {
          session.theme = sessions.title;
          sessionData.data.push( session );
        });
      });

      processSessions( err, JSON.stringify( sessionData ) );
    });
  }

  done( (new Error( 'Theme not found.' ) ), {} );
}

/**
 * Gets the number of proposals each theme has
 *
 * @param  {Function} done The callback which given an err, an object in form theme:count
 */
function getThemeCounts( done ) {
  // getSessions for each theme, count results for each
  var themes = getThemeSlugs();
  var pendingGets = themes.length;
  var counts = {};
  var errs;

  themes.forEach( function( theme, idx ) {
    getSessions( theme, function( err, sessions ) {
      if ( err ) {
        if( ! Array.isArray( errs ) ) {
          errs = [ err ];
          return errs;
        }
        return errs.push( err );
      }

      counts[ theme ] = sessions.length;

      pendingGets = pendingGets - 1;

      if( pendingGets === 0 ) {
        done( errs, counts );
      }
    });
  });
}

module.exports = {
  getSessions: getSessions,
  getTheme: getTheme,
  getThemes: getThemes,
  getThemeCounts: getThemeCounts,
  getThemeSlugs: getThemeSlugs
};
