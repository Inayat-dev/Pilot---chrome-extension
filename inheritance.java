class father{
    public void house(){
        System.out.println("House")
    }

    
}

class son extends father{
    public void bike(){
        System.out.println("Bike")
    }
}

class inheritance{
    public static void main(String[] agrs){
        son s1 = new son();
        s1. bike();
        s1.house();
    }
}