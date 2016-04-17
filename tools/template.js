var fs = require('fs');
var _ = require('lodash');
var esprima = require('esprima');

// disable ES6 delimiters
_.templateSettings.interpolate = /<%=([\s\S]+?)%>/g;

var obj = {};

for (var m of ['style']) {
  obj[`require_${m}`] = () => require(`./${m}`);
}

var read     = obj.read     = filename => fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
var readJSON = obj.readJSON = filename => JSON.parse(read(filename));
obj.readBase64              = filename => fs.readFileSync(filename).toString('base64');

// Convert JSON object to Coffeescript expression (via embedded JS).
var constExpression = data => '`' + JSON.stringify(data).replace(/`/g, '\\`') + '`';

obj.multiline = function(text) {
  return text.replace(/\n+/g, '\n').split(/^/m).map(JSON.stringify).join(' +\n').replace(/`/g, '\\`');
};

obj.importHTML = function(filename) {
  var text = read(`src/${filename}.html`).replace(/^ +/gm, '').replace(/\r?\n/g, '');
  text = _.template(text)(pkg); // variables only; no recursive imports
  return obj.html(text);
};

function TextStream(text) {
  this.text = text;
}

TextStream.prototype.eat = function(regexp) {
  var match = regexp.exec(this.text);
  if (match && match.index === 0) {
    this.text = this.text.slice(match[0].length);
  }
  return match;
};

function parseHTMLTemplate(stream, context) {
  var template = stream.text; // text from beginning, for error messages
  var expression = new HTMLExpression(context);
  var match;

  try {

    while (stream.text) {
      // Literal HTML
      if ((match = stream.eat(
        // characters not indicating start or end of placeholder, using backslash as escape
        /^(?:[^\\{}]|\\.)+(?!{)/
      ))) {
        var unescaped = match[0].replace(/\\(.)/g, '$1');
        expression.addLiteral(unescaped);

      // Placeholder
      } else if ((match = stream.eat(
        // symbol identifying placeholder type and first argument (enclosed by {})
        // backtick not allowed in arguments as it can end embedded JS in Coffeescript
        /^([^}]){([^}`]*)}/
      ))) {
        var type = match[1];
        var args = [match[2]];
        if (type === '?') {
          // conditional expression can take up to two subtemplate arguments
          for (var i = 0; i < 2 && stream.eat(/^{/); i++) {
            var subtemplate = parseHTMLTemplate(stream, context);
            args.push(subtemplate);
            if (!stream.eat(/^}/)) {
              throw new Error(`Unexpected characters in subtemplate (${stream.text})`);
            }
          }
        }
        expression.addPlaceholder(new Placeholder(type, args));

      // No match: end of subtemplate (} next) or error
      } else {
        break;
      }
    }

    return expression.build();

  } catch(err) {
    throw new Error(`${err.message}: ${template}`);
  }
}

function HTMLExpression(context) {
  this.parts = [];
  this.startContext = this.endContext = (context || '');
}

HTMLExpression.prototype.addLiteral = function(text) {
  this.parts.push(constExpression(text));
  this.endContext = (
    this.endContext
      .replace(/(=['"])[^'"<>]*/g, '$1')                    // remove values from quoted attributes (no '"<> allowed)
      .replace(/(<\w+)( [\w-]+((?=[ >])|=''|=""))*/g, '$1') // remove attributes from tags
      .replace(/^([^'"<>]+|<\/?\w+>)*/, '')                 // remove text (no '"<> allowed) and tags
  );
};

HTMLExpression.prototype.addPlaceholder = function(placeholder) {
  if (!placeholder.allowed(this.endContext)) {
    throw new Error(`Illegal insertion of placeholder (type ${placeholder.type}) into HTML template (at ${this.endContext})`);
  }
  this.parts.push(placeholder.build());
};

HTMLExpression.prototype.build = function() {
  if (this.startContext !== this.endContext) {
    throw new Error(`HTML template is ill-formed (at ${this.endContext})`);
  }
  return (this.parts.length === 0 ? '""' : this.parts.join(' + '));
};

function Placeholder(type, args) {
  this.type = type;
  this.args = args;
}

Placeholder.prototype.allowed = function(context) {
  switch(this.type) {
    case '$':
      // escaped text allowed outside tags or in quoted attributes
      return (context === '' || /\=['"]$/.test(context));
    case '&':
    case '@':
      // contents of one/many HTML element or template allowed outside tags only
      return (context === '');
    case '?':
      // conditionals allowed anywhere so long as their contents don't change context (checked by HTMLExpression.prototype.build)
      return true;
  }
  throw new Error(`Unrecognized placeholder type (${this.type})`);
};

Placeholder.prototype.build = function() {
  // first argument is always JS expression; validate it so we don't accidentally break out of placeholders
  var expr = this.args[0];
  var ast;
  try {
    ast = esprima.parse(expr);
  } catch (err) {
    throw new Error(`Invalid JavaScript in template (${expr})`);
  }
  if (!(ast.type === 'Program' && ast.body.length == 1 && ast.body[0].type === 'ExpressionStatement')) {
    throw new Error(`JavaScript in template is not an expression (${expr})`);
  }
  switch(this.type) {
    case '$': return `\`E(${expr})\``;        // $ : escaped text
    case '&': return `\`(${expr}).innerHTML\``; // & : contents of HTML element or template (of form {innerHTML: "safeHTML"})
    case '@': return `\`E.cat(${expr})\``;    // @ : contents of array of HTML elements or templates (see src/General/Globals.coffee for E.cat)
    case '?':
      return `(if \`(${expr})\` then ${this.args[1] || '""'} else ${this.args[2] || '""'})`; // ? : conditional expression
  }
  throw new Error(`Unrecognized placeholder type (${this.type})`);
};

// HTML template generator with placeholders of forms ${}, &{}, @{}, and ?{}{}{} (see Placeholder.prototype.build)
// that checks safety of generated expressions at compile time.
obj.html = function(template) {
  var stream = new TextStream(template);
  var output = parseHTMLTemplate(stream);
  if (stream.text) {
    throw new Error(`Unexpected characters in template (${stream.text}): ${template}`);
  }
  return `(innerHTML: ${output})`;
};

obj.assert = function(flagFile, statement) {
  if (!readJSON(flagFile)) return '';
  return `throw new Error 'Assertion failed: ' + ${constExpression(statement)} unless ${statement}`;
};

// Import variables from package.json.
var pkg = readJSON('package.json');

// Take variables from command line.
for (var i = 4; i < process.argv.length; i++) {
  var m = process.argv[i].match(/(.*?)=(.*)/);
  pkg[m[1]] = m[2];
}

_.assign(obj, pkg);

var text = read(process.argv[2]);
text = _.template(text)(obj);
fs.writeFileSync(process.argv[3], text);