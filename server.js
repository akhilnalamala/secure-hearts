var express = require('express');
var fs = require('fs');
var https = require('https');
var app = express();
var path = require('path');
var socketIO = require('socket.io');
//https server using self signed cert
var server = https.createServer({key: fs.readFileSync('server.key'), cert: fs.readFileSync('server.cert'),}, app);
var io = socketIO(server);  // Binding socket to the server
const uuid = require('uuid').v4; 
server.listen(5000, function() { // Listen on port 500
  console.log('Starting server on port 5000');
});
const bodyParser = require('body-parser'); //To extract username and password for login and registration purpose 
const expressSession = require("express-session"); // for session-based authentication 
const sessionMiddleware = require('express-session')({ //session information and parameters
  secret: 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true, 
    secure: true,
    sameSite: 'strict'
  },  
  store: new (require("connect-mongo")(expressSession))({ //storing session information on the database
        url: "mongodb://localhost/session"
    })
});
//Security measures
const helmet = require('helmet');
app.use(helmet.frameguard());
app.disable('x-powered-by');
app.use(helmet.dnsPrefetchControl());
app.use(helmet.expectCt());
app.use(helmet.hidePoweredBy());
app.use(helmet.hsts());
app.use(helmet.ieNoOpen());
app.use(helmet.noSniff());
app.use(helmet.permittedCrossDomainPolicies());
app.use(helmet.referrerPolicy());
app.use(helmet.xssFilter());
app.use((req, res, next) => {
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
})
app.use(function (req, res, next) {
    res.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.header('Expires', '-1');
    res.header('Pragma', 'no-cache');
    next()
})

//Other middlewares for parsing, authentication and session-handling
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));//urlencoded: Returns middleware that only parses urlencoded bodies and only looks at requests where the Content-Type header matches the type option
app.use(sessionMiddleware);
const passport = require('passport'); //authentication middleware for Node.js
app.use(passport.initialize()); //Initialize passport 
app.use(passport.session());
//MongoDB 
const mongoose = require('mongoose');//ODM library
const passportLocalMongoose = require('passport-local-mongoose'); //Mongoose plugin that simplifies building username and password login with Passport.
//Connect to DB
mongoose.connect('mongodb://localhost/testDB',
  { useNewUrlParser: true, useUnifiedTopology: true }); //connect to the db named => MyDatabase

const Schema = mongoose.Schema; //Defining a schema
const UserDetail = new Schema({
  username: String,
  password: String,
  win: Number,
  loss: Number
});
UserDetail.plugin(passportLocalMongoose);
const UserDetails = mongoose.model('userInfo', UserDetail, 'userInfo');
passport.use(UserDetails.createStrategy());
passport.serializeUser(UserDetails.serializeUser());
passport.deserializeUser(UserDetails.deserializeUser());

/* DEFINING ROUTES */
const connectEnsureLogin = require('connect-ensure-login');
app.post('/login', (req, res, next) => { //login
  passport.authenticate('local',
  (err, user, info) => {
    if (err) {
      return next(err);
    }

    if (!user) {
      return res.redirect('/login?info=Invalid authentication information');
    }

    req.logIn(user, function(err) {
      if (err) {
        return next(err);
      }

      return res.redirect('/');
    });

  })(req, res, next);
});
//GET Login
app.get('/login',
  (req, res) => res.sendFile('login.html',
  { root: __dirname })
);
//Registering with Input validation
app.get('/register',
  (req, res) => res.sendFile('register.html',
  { root: __dirname })
);
//Regex to validate username and password
var input_validator = /^[a-z0-9]{3,15}$/; //Alphanumeric string with min length of 3 and max length of 15
var password_validator = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,}$/; // Minimum eight characters, one letter and one number
app.post('/register',function(req,res){
  const username = req.body.username;  
  const pwd = req.body.password;
  //validate username and password strings
  if(!username.match(input_validator) || !pwd.match(password_validator)){
    var info = "Username or password not valid"
    return res.redirect('/register?info=' + info);
  } 
  //After validation => store the information into the db (The password is encrypted using salted hash internally using passport)
  UserDetails.register({username:req.body.username, active: false, win:0, loss:0}, req.body.password,(error,user)=>{
    if(user){
      res.redirect('/login?info=Successfully Registered');    
    }else{
      res.redirect('/register?info=User Exists');
    }
  });
});
//Logout
app.get('/logout', function(req, res){
  req.logout();
  res.redirect('/');
});
//Default get request to the server renders the index.html file if authenticated, else goes to the login page
app.get('/',
  connectEnsureLogin.ensureLoggedIn('/login'),
  function(req, res) {
    res.sendFile('index.html',
    { root: __dirname })
});
 
/*SOCKET BEGINS*/
const MAX_WAITING = 30000; // Maximum waiting time until timeout
var timeOut; //timeOut object
var count = 0; //variable used to check if all 4 players passed their cards in the beginning
var Shuffle = require('shuffle'); // Shuffle library for deck
var scores = {}; // map that associates user with their scores
var hand = {};  // map that associates user with ther hand of cards
var connectedUsers = []; // array that keeps track of connected users
var rooms = {}; // rooms is a dictonary that maps room id to associated rooms
const threshold = 50; //Points to end game
io.use(function(socket, next){
        // Wrap the express middleware
        sessionMiddleware(socket.request, {}, next);
    }); 
io.on('connection',function(socket){  // On socket connection 
  var userId = socket.request.session.passport.user;
  socket.emit('welcome', "Welcome " + userId);
  var stats = [];
  UserDetails.find({}, function(err, users) {
    for(var obj in users){
      stats.push({username: users[obj].username,win:users[obj].win,loss:users[obj].loss});
    }
    console.log(stats);
    socket.emit('takeStats',stats);
  });

  function forefeit(socket){
    const room = rooms[socket.roomId];
    console.log(room);
    io.sockets.in(room.id).emit('forefeit',socket.id +' has forefeit the game');
  }
  function triggerTimeout(user){
     timeOut = setTimeout(()=>{  
      forefeit(user);
      UserDetails.findOneAndUpdate({username: user.request.session.passport.user}, {$inc: {loss: 1}}, function (err, doc) {
      if (err) return res.send(500, {error: err});
        return doc;
     })
     },MAX_WAITING);
   }

   function resetTimeOut(){
      if(typeof timeOut === 'object'){
        console.log("timeout reset");
        clearTimeout(timeOut);
      }
   }
  
  if(connectedUsers.includes(userId)){
    console.log('Socket already exists');
    socket.emit('userExists',"You are already logged in another tab");
    socket.disconnect(true);
  }
  connectedUsers.push(userId);
  console.log("Your User ID is", userId);  
  socket.on('createRoom',function(data){ // On event create room => create a room object with a unique id
    if(!data.match(input_validator)){
      socket.emit('roomErr','Please input a valid room name');
      return;
    }
    const room = {
      name: data,
      id: uuid(), // uuid() is used to assign unique ids to the rooms
      //sockets: [], // sockets array to keep track of all socket connections in the room
      game: false, //to indicate whether the game has begun
      userID: [],
      const_userID: [], // This is the final list of users, once the game begins
      state: false, // Game state changes to false when the game is paused when user leaves the room
      socketId_userId_map: {}, // Creating a relationship of socketid to userid
      round: 1, 
      currentTurn: 0, // To keep a track of whose turn it is to play
      trick: 0, // Keeping track if all 4 players have played and ending the trick
      tricks: {}, // Map to keep track of which player played what, at the end of the trick this will compute the winner
      currentSuit: 'Club', // Keeping Track of the current Suit in the room
      heartBroken: false,
      gameNo: 1
    }
    room.userID.push(userId); // Adding the current socket into the room 
    room.socketId_userId_map[userId] = socket.id;
    rooms[room.id] = room; // Creating a mapping from room id to the room object (kinda like a hashmap)
    socket.roomId = room.id; // setting the roomId of the socket to the room's generated id
    socket.join(room.id); // Finally joining the room
    console.log(rooms); 
    //Emitting an event in that particular room (This event on the client side displays the message below )
    io.sockets.in(room.id).emit('connectToRoom', "Welcome to Room: "+room.name +"  |  Number of players in the room: " + room.userID.length);
    io.sockets.in(room.id).emit('requiredPlayers', "Waiting for "+ (4 - room.userID.length) + " players <br> The game will begin once there are 4 Players in the room");
    io.sockets.in(room.id).emit('playersInTheRoom',room.userID);  
  });

  socket.on('getRooms', function(){ //Get Rooms event is triggered from the client to display available rooms
      const roomNames = []; 
      for (const id in rooms) {
          const {name} = rooms[id];
          const room = {name, id};
          roomNames.push(room);
      }
      socket.emit('takeRooms',roomNames); //server prepares a list of available rooms and emits an event  
    });

    socket.on('joinRoom', function(data){ // client triggers this event to join existing rooms
      const room = rooms[data];  // data is the room id from the client
      if(room.game == true && room.state == true) {
        socket.emit('roomFull');
        return;   
      }
      if(room.game){
        if(!room.state){
          if(!room.const_userID.includes(socket.request.session.passport.user)){
            socket.emit('roomFull');
            return;
          }
        }
      }
      room.userID.push(socket.request.session.passport.user);
      room.socketId_userId_map[socket.request.session.passport.user] = socket.id;
      socket.roomId = room.id;
      socket.join(room.id);
      io.sockets.in(room.id).emit('connectToRoom', "Welcome to Room: "+room.name +"  |  Number of players in the room: " + room.userID.length);
      if(room.userID.length == 4){
        room.game = true;
        room.state = true;
        if(room.const_userID.length != 4){
          for (var i of room.userID) {
            room.const_userID.push(i);
            scores[i] = 0; // Initialize the scores to zero
          }
          io.sockets.in(room.id).emit('beginGame', "Game will begin now");
          io.sockets.in(room.id).emit('playersInTheRoom',room.userID);
          initGame(room);
        }
    }
    io.sockets.in(room.id).emit('playersInTheRoom',room.userID);
    io.sockets.in(room.id).emit('requiredPlayers', "Waiting for "+ (4 - room.userID.length) + " players");        
  });

  function initGame(room){
    io.sockets.in(room.id).emit('gameNumber', room.gameNo);
    room.currentSuit = 'Club';
    room.round = 1;
    room.trick = 0;
    room.heartBroken = false;
    room.tricks = {};
    var scoresToSend = [];
    //shuffle the deck
    var deck = Shuffle.shuffle();
    //record the decks (map from client to hand) and distribute the cards
    for(var client in room.userID){ 
      //scores of clients
      scoresToSend.push({name: room.userID[client], score: scores[room.userID[client]]}); 
      hand[room.userID[client]] = deck.draw(13); //store in server memory which player has what card
      //distribute hands to indiviual clients
      if(room.gameNo % 4 == 0){
        io.to(room.socketId_userId_map[room.userID[client]]).emit('takeCards',hand[room.userID[client]]);
      }else{
        io.to(room.socketId_userId_map[room.userID[client]]).emit('initCards',hand[room.userID[client]]);
      }
    }
    io.sockets.in(room.id).emit('takeScores',scoresToSend);
    if(room.gameNo % 4 == 0){
      firstTurn(room);   
    }
  }


  
  socket.on('passing',function(data){
    var room = rooms[socket.roomId];
    var user = socket.request.session.passport.user;
    console.log(hand[user]);
    var temp = [];
    for(var card in data){
      var arr = data[card].split(','); // data is returned as a string => convert to array to access suit and number
      var suit = arr[0]; // suit  
      var description = arr[1]; // card number
      //search for the three cards in the current sockets hand,store it in an array and remove it
      for (var i=0; i < hand[user].length; i++) {
        if (hand[user][i].suit === suit && hand[user][i].description === description) {
            //store it in an temporary array
            temp.push(hand[user][i]); 
            //delete from the main array
            hand[user] = hand[user].filter(item => item !== hand[user][i]);
        }
      } 
    }
    //the next socket gets the cards
    var i = 0;
    while(i < room.userID.length){
      if(user === room.userID[i]){
        break;
      }
      i++;
    }
    var offset = 0;
    if(room.gameNo%4 === 1){
      offset = 1;
    }
    if(room.gameNo%4 === 2){
      offset = -1;
    }
    if(room.gameNo%4 === 3){
      offset = 2;
    }
    var index = (i+offset) % room.userID.length;
    if(index < 0) {
      index = 3;
    }
    for(var j in temp){
      hand[room.userID[index]].push(temp[j]);
    }
    io.to(room.socketId_userId_map[room.userID[index]]).emit('newCards',temp+ " sent by " + room.userID[i]);
    count++;
    if(count == 4){
      for(var client in room.userID){
        io.to(room.socketId_userId_map[room.userID[client]]).emit('takeCards',hand[room.userID[client]]);
      }
      count = 0;
      firstTurn(room);
    }
  })


  function firstTurn(room){
    for(var client in room.userID){
      var temp = hand[room.userID[client]]; 
      var bool = search('Club','Two',temp);
      console.log(bool);
      if(bool){
        console.log(client);
        room.currentTurn = client;
        nextTurn(room);
        break;
      } 
    }
  }

  function search(suit, description, myArray){
    for (var i=0; i < myArray.length; i++) {
        if (myArray[i].suit === suit && myArray[i].description === description) {
            return true;
        }
    }
    return false;
  }




  function nextTurn(room){
    room.trick++;
    if(room.trick > 4){
      console.log('trick has ended: do some compute');
      //determineWinner(room);
      var points = 0;
      var winner = {
        sort: -1,
        name: 'noone'
      };
      for(var client in room.tricks){
        if(room.tricks[client].suit === room.currentSuit){
          if(winner.sort < room.tricks[client].sort){
            winner.sort = room.tricks[client].sort;
            winner.name = client;
          }
        }
        if(room.tricks[client].suit === 'Heart'){
            room.heartBroken = true;
            points = points + 1;
          }
          if(room.tricks[client].suit === 'Spade' && room.tricks[client].description === 'Queen'){
            points = points + 13;
          }
      }
      var x = scores[winner.name];
      scores[winner.name] = x + points;
      console.log("Winner: "+winner.name);
      console.log(scores[winner.name]);
      console.log(room.heartBroken); 
      var scoresToSend = [];
      for(var client in room.userID){ 
      //scores of clients
        scoresToSend.push({name: room.userID[client], score: scores[room.userID[client]]}); 
      }
      io.sockets.in(room.id).emit('takeScores',scoresToSend);  
      io.sockets.in(room.id).emit('trickEnded',winner.name + 'takes all cards in this round');

      if(room.round >= 13){
        //check if someone reached threshold
        for(var client in room.userID){
          if(scores[client] >= threshold){
            console.log('game over');
            console.log('Stats will be updated on the dashboard');
            console.log('The one with the min score wins');
            var winner= {
              name: 'none',
              min: 0
            };
            for(var client in room.UserID){
              if(scores[client] < winner.min){
                winner.name = client;
                winner.min = scores[client];
              }
            }
            //emit to clients
            io.sockets.in(room.id).emit('winnerGame',winner.name);
            //connect to the db and update stats
            UserDetails.findOneAndUpdate({username: winner.name}, {$inc: {win: 1}}, function (err, doc) {
              if (err) return res.send(500, {error: err});
                return doc;
            });
            //disconnect all users from the room
            for(var client in room.userID){
              io.sockets.connected[room.socketId_userId_map[client]].disconnect();  
            }
            
          }
        }
        room.gameNo++;
        //If not reset game
        initGame(room);
      }
      //set current turn to the winner
      var i = 0;
      while(i < room.userID.length){
        if(room.userID[i] === winner.name){
          room.currentTurn = i;
          break;
        }
        i++;
      }
      //emit an event to display who the winner of the trick was and update scores
      room.trick = 1;
      room.round++;
      room.tricks = {};
      //set trick to empty again 
    }
    var temp = room.currentTurn % room.userID.length;
    if(room.trick === 1 && room.round === 1){
      io.to(room.socketId_userId_map[room.userID[temp]]).emit('pleasePlay', 'You need to pick Two of Club'); 
      io.sockets.in(room.id).emit('turn',room.userID[temp]+ ' will play');
      triggerTimeout(socket);
      return; 
    }
    io.to(room.socketId_userId_map[room.userID[temp]]).emit('pleasePlay', 'Your turn');
    io.sockets.in(room.id).emit('turn',room.userID[temp]+ ' will play');
    triggerTimeout(socket);
  }



  //When a client picks a card
  socket.on('cardPicked',function(data){ //need to validate data here..
    resetTimeOut();
    const room = rooms[socket.roomId]; // find the room of the socket
    var index = room.currentTurn % room.userID.length;
    if(socket.id !== room.socketId_userId_map[room.userID[index]]){
      console.log('will forefeit => someone cheated');
    }
    var user = socket.request.session.passport.user;
    var arr = data.split(','); // data is returned as a string => convert to array to access suit and number
    var suit = arr[0]; // suit  
    var description = arr[1]; // card number
    //validate card here
    if(room.trick === 1 && room.round === 1){ // If it is the fist turn of the first round 
      if(suit !== 'Club' || description !== 'Two'){ // The card has to be Two of club
        io.to(socket.id).emit('errorMsg', 'Invalid Card: Please Select Two of Club');
        triggerTimeout(socket);
        return;
      }
    }
    if(room.round === 1){ // if it is the first round
      if(suit === 'Spade' && description === 'Queen'){ // The user cannot select a Queen of Spade
        io.to(socket.id).emit('errorMsg', 'Invalid Card: You cannot select Queen of Spade in the first round');
        triggerTimeout(socket);
        return;  
      }
    }
    if(room.round === 1){ //If it is the first turn and heart is not broken yet 
      if(suit === 'Heart'){ 
        io.to(socket.id).emit('errorMsg', 'Invalid Card: Cannot Play a Heart in the first round'); 
        triggerTimeout(socket);
        return;
      }
    }
    if(room.trick === 1){ //If it is the first turn and heart is not broken yet 
      if(room.heartBroken === false && suit === 'Heart'){ 
        io.to(socket.id).emit('errorMsg', 'Invalid Card: Heart is not broken yet'); 
        triggerTimeout(socket);
        return;
      }
    }
    if(room.trick === 1){ //If it is the first trick 
      room.currentSuit = suit; //set the current suit 
    }
    if(room.trick != 1){ 
      if(suit !== room.currentSuit){
        var getCards = hand[socket.request.session.passport.user];
        for (var i=0; i < getCards.length; i++) {
          if(getCards[i].suit === room.currentSuit) {
            io.to(socket.id).emit('errorMsg', 'Invalid Card: Please select a card of the current suit'); 
            triggerTimeout(socket);
            return;        
          }
        }
      }
    }
    if(suit == 'Spade' && description === 'Queen' && room.heartBroken === false){ // Cannot use the Queen of Spade if heart is not broken
      io.to(socket.id).emit('errorMsg', 'Invalid Card: Heart is not broken yet'); 
      triggerTimeout(socket);
      return;
    }

    var client = socket.request.session.passport.user; //user id of the client
    var temp = hand[client]; // fetching the hand of this client
    //remove the card that is played and push it into the tricks map
    for (var i=0; i < hand[client].length; i++) {
        if (hand[client][i].suit === suit && hand[client][i].description === description) {
            room.tricks[client] = hand[client][i];
            hand[client] = hand[client].filter(item => item !== hand[client][i]); 
            io.to(socket.id).emit('takeCards', hand[client]);
            break;
        }
    }
    io.sockets.in(room.id).emit('cardPlayed', client + " played " + data);
    room.currentTurn++; 
    nextTurn(room);          
  });

  socket.on('disconnect',function(){ //When a socket disconnects 
    var userId = socket.request.session.passport.user;
    if(connectedUsers.includes(userId)){
      connectedUsers = connectedUsers.filter(item => item !== userId);
    }

    console.log('A user disconnected');
    const roomsToDelete = []; 
      for (const id in rooms) {
        const room = rooms[id];
        console.log(room);
        // check to see if the socket is in the current room
        if (room.userID.includes(socket.request.session.passport.user)) { 
            console.log(id);
            socket.leave(id);
            // remove the socket from the room object
            room.userID = room.userID.filter(item => item !== socket.request.session.passport.user);
            delete room.socketId_userId_map[room.userID];
            if(room.game){
              room.state = false;
              io.sockets.in(room.id).emit('playerLeft',socket.request.session.passport.user+" left the room. Waiting to re-connect for 15s");
              setTimeout(function(){
               if(room.state){
                console.log('Game will continue');       
               }else{
                  console.log('Game will end');
               } 
              }, 15000);        
            }
        }
        // Prepare to delete any rooms that are now empty
        if (room.userID.length == 0) {
          console.log("Array length fine");
          roomsToDelete.push(room);
        }
        for (const room of roomsToDelete) {
          delete rooms[room.id];
        }
        io.sockets.in(room.id).emit('connectToRoom', "Welcome to Room: "+room.name +"  |  Number of players in the room: " + room.userID.length);
        io.sockets.in(room.id).emit('requiredPlayers', "Waiting for "+ (4 - room.userID.length)  + " players");
        io.sockets.in(room.id).emit('playersInTheRoom',room.userID);
      }
  });
});




