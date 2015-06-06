var debug = require('debug')('mdns:lib:networking');
var debuginbound = require('debug')('mdns:inbound');
var debugoutbound = require('debug')('mdns:outbound');

var util = require('util');
var EventEmitter = require('events').EventEmitter;
var os = require('os');
var dgram = require('dgram');
var semver = require('semver');

var dns = require('mdns-js-packet');
var DNSPacket = dns.DNSPacket;
//var DNSRecord = dns.DNSRecord;

var MDNS_MULTICAST = '224.0.0.251';
var MDNS_MULTICAST_PORT = 5353;


var Networking = module.exports = function (options) {
  options = options || {};
  this.created = 0;
  this.connections = [];
  // a List of IPs we need to add multicast membership.
  this.ips =[];
  this.started = false;
  this.users = [];
  this.INADDR_ANY = typeof options.INADDR_ANY === 'undefined' ?
    false : options.INADDR_ANY;
};

util.inherits(Networking, EventEmitter);


Networking.prototype.start = function () {
  var interfaces = os.networkInterfaces();
  var index = 0;
  for (var key in interfaces) {
    if (interfaces.hasOwnProperty(key)) {
      for (var i = 0; i < interfaces[key].length; i++) {
        var iface = interfaces[key][i];
        //no localhost
        if (iface.internal) {
          continue;
        }
        //no IPv6 addresses
        if (iface.address.indexOf(':') !== -1) {
          continue;
        }
         //Sometimes, There are multipule interfaces with same IPs.
        if ( this.ips.indexOf(iface.address) == -1 ) {
          debug('added %s interface address %s', key, iface.address);
          this.ips.push(iface.address);
          //keeping index just for convenience.
          index++
        } else { 
          debug('this %s interface address %s already exists!', key, iface.address);
        }
      }
    }
  }

//  There will be only one socket on 0.0.0.0:5353
    this.createSocket();
};


Networking.prototype.stop = function () {
  debug('stopping');

  this.connections.forEach(closeEach);
  this.connections = [];

  function closeEach(connection) {
    var socket = connection.socket;
    socket.close();
    socket.unref();
  }
};


Networking.prototype.createSocket = function () {
  var sock;
  // for further refrence:
  var _me = this;
  if (semver.gte(process.versions.node, '0.11.13')) {
    sock = dgram.createSocket({type:'udp4', reuseAddr:true});
  } else {
    sock = dgram.createSocket('udp4');
  }
  debug('creating socket for %s:%d', '0.0.0.0',MDNS_MULTICAST_PORT);
  this.created++;

  sock.bind(MDNS_MULTICAST_PORT,'0.0.0.0', function () {
      debug("Membership adding for %d ips.",_me.ips.length);
    
    for(var i=0; i <_me.ips.length;i++) {
      sock.addMembership(MDNS_MULTICAST,_me.ips[i]);
      debug("Membership added for '%s'",_me.ips[i]);
    }
    sock.setMulticastTTL(255);
    sock.setMulticastLoopback(true);
    _me.bindToAddress(null,0, 'pseudo multicast', sock);
  });

};


Networking.prototype.bindToAddress = function (
  err, interfaceIndex, networkInterface, sock) {
  if (err) {
    debug('there was an error binding %s', err);
    return;
  }
  debug('bindToAddress', networkInterface);
  var info = sock.address();

  var connection = {
    socket:sock,
    interfaceIndex: interfaceIndex,
    networkInterface: networkInterface,
    counters: {
      sent: 0,
      received: 0
    }
  };

  this.connections.push(connection);
  var self = this;

  sock.on('message', function (message, remote) {
    var packets;
    connection.counters.received++;
    debuginbound('incomming message', message.toString('hex'));
    try {
      packets = dns.DNSPacket.parse(message);
      if (!(packets instanceof Array)) {
        packets = [packets];
      }

      self.emit('packets', packets, remote, connection);
    }
    catch (err) {
      //partial, skip it
      debug('packet parsing error', err);
    }
  });

  sock.on('error', self.onError.bind(self));

  sock.on('close', function () {
    debug('socket closed', info);
  });


  if (this.created === this.connections.length) {
    this.emit('ready', this.connections.length);
  }
};//--bindToAddress


Networking.prototype.onError = function (err) {
  this.emit('error', err);
};


Networking.prototype.send = function (packet) {
  var buf = DNSPacket.toBuffer(packet);
  this.connections.forEach(onEach);
  debug('created buffer with length', buf.length);
  debugoutbound('message', buf.toString('hex'));
  function onEach(connection) {
    var sock = connection.socket;
    debug('sending to', sock.address());

    sock.send(buf, 0, buf.length, 5353, '224.0.0.251', function (err, bytes) {
      connection.counters.sent++;
      debug('%s sent %d bytes with err:%s', sock.address().address, bytes, err);
    });
  }
};

Networking.prototype.startRequest = function (callback) {
  if (this.started) {
    return process.nextTick(callback());
  }
  this.start();
  this.once('ready', function () {
    if (typeof callback === 'function') {
      callback();
    }
  });
};


Networking.prototype.stopRequest = function () {
  if (this.users.length === 0) {
    this.stop();
  }
};


Networking.prototype.addUsage = function (browser, next) {
  this.users.push(browser);
  this.startRequest(next);
};


Networking.prototype.removeUsage = function (browser) {
  var index = this.users.indexOf(browser);
  if (index > -1) {
    this.users.splice(index, 1);
  }
  this.stopRequest();
};

