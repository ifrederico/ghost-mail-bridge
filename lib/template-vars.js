// Replace %recipient.varname% patterns in a string using a recipient's variable map.
// Unmatched patterns are left as-is (defensive).

function substituteVars(str, vars) {
  if (!str || !vars) return str;
  return str.replace(/%recipient\.([^%]+)%/g, function(match, varName) {
    return vars[varName] !== undefined ? vars[varName] : match;
  });
}

module.exports = substituteVars;
