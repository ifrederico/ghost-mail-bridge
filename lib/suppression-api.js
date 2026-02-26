var { deleteSuppression } = require('./db');

var VALID_TYPES = { bounces: true, complaints: true, unsubscribes: true };

function handleDeleteSuppression(req, res) {
  var type = req.params.type;
  var email = decodeURIComponent(req.params.email);

  if (!VALID_TYPES[type]) {
    return res.status(404).json({ message: 'Unknown suppression type: ' + type });
  }

  deleteSuppression.run(email, type);

  res.json({
    message: 'Address has been removed',
    value: '',
    address: email
  });
}

module.exports = handleDeleteSuppression;
