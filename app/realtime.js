module.exports = {
    http:undefined,
    IO:undefined,
    io:undefined,
    app:undefined,
    endpoint:undefined,
    socket:undefined,
    socketMap:{},
    init:function(endpoint) {

        console.log("Init socket.io on: " + endpoint);
        this.endpoint = endpoint;
        this.io = require('socket.io-client');
    },
    connect:function(id, callback) {
        var self = this;
        if (this.socket) {
            this.disconnect();
        }

        var connectionCallback = callback;
        
        this.socket = this.io.connect(this.endpoint);
        this.propertyId = id;

        this.socket.on('connect', function(){
            console.log("socket connect")

            self.socket.emit('upgrade', id);
        });


        this.socket.on('disconnect', function(){
            console.log('socket disconnect');
        });

        this.socket.on('upgrade', function(){
            console.log('socket upgraded');
            self.emit("Messaging Server Connected...");

            if (connectionCallback) {
                connectionCallback();
                connectionCallback = undefined;
            }
        });

        this.socket.on('data', function(data){
            console.log(data);
        });
    },
    disconnect:function(id) {

        if (this.socket) {
            this.socket.disconnect();
            this.socket = undefined;
        }
        this.propertyId = undefined;
    },
    emit:function(data, eventType) {
        if (eventType == undefined) {
            eventType = 'data'
        }
        console.log(this.propertyId, data)
        if (this.socket) {
            this.socket.emit(eventType, this.propertyId, data)
        }
    }
}